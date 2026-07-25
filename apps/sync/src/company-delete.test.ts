// Hard-deleting a company: the operator-facing "delete my account" primitive, and the only way to
// get a genuinely clean re-run when testing sign-in with the same email.
//
// `revoke` is NOT this, and cannot be made into it. findOperatorBySupabaseSub does not filter on
// status, so a revoked operator is still resolved by sub: signing in again mints fresh machine
// tokens for an operator whose permissions were dropped, producing a token that authenticates but
// can read and write nothing. And leaving the company row behind poisons the slug, because
// dedupeSlug suffixes -2, -3 - so the "same" company comes back under a different name.
//
// Delete therefore has to remove: the company, its operators, their machines, their setup tokens,
// their permissions, its audit rows, and the bare repos on disk. Everything except `core`, which is
// the shared read-only pack every company reads.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices, type Services } from "./server.js";

const KEY = "k".repeat(32);
let dir: string;
let services: Services;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "buildex-delete-"));
  services = await createServices({ serviceKey: KEY, publicBaseUrl: "https://sync.example.test", dataDir: dir, port: 0 });
});
afterEach(() => {
  services.close();
  rmSync(dir, { recursive: true, force: true });
});

const s2s = (path: string, body: unknown): Request =>
  new Request(`http://sync.test${path}`, {
    method: "POST",
    headers: { "x-service-key": KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const del = (slug: string, key: string = KEY): Request =>
  new Request(`http://sync.test/s2s/companies/${slug}`, { method: "DELETE", headers: { "x-service-key": key } });

const repoDir = (name: string): string => join(dir, "repos", `${name}.git`);

/** Stand up a company the way a real sign-in does, so deletion is tested against real rows. */
async function seedCompany(slug: string): Promise<{ operatorId: string; setupToken: string }> {
  await services.handler(s2s("/s2s/companies", { id: `c-${slug}`, slug, name: slug }));
  await services.handler(s2s("/s2s/operators", { id: `o-${slug}`, companyId: `c-${slug}`, email: `${slug}@example.test` }));
  const minted = await services.handler(s2s("/s2s/setup-tokens", { operatorId: `o-${slug}` }));
  const { setupToken } = (await minted.json()) as { setupToken: string };
  await services.handler(
    new Request("http://sync.test/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken, machineName: "laptop" }),
    }),
  );
  return { operatorId: `o-${slug}`, setupToken };
}

describe("DELETE /s2s/companies/<slug> - hard delete, so the same email can start over clean", () => {
  it("removes the company, its people, and its repos - but never core", async () => {
    const { operatorId } = await seedCompany("acme");
    expect(existsSync(repoDir("team-acme"))).toBe(true);
    expect(existsSync(repoDir(`private-${operatorId}`))).toBe(true);
    expect(existsSync(repoDir("core"))).toBe(true);

    const res = await services.handler(del("acme"));
    expect(res.status).toBe(200);
    const bodyJson = (await res.json()) as { ok: boolean; slug: string; repos: string[] };
    expect(bodyJson.ok).toBe(true);
    expect(bodyJson.slug).toBe("acme");
    // Order is not part of the contract - the list comes from a DISTINCT over the permission matrix.
    expect([...bodyJson.repos].sort()).toEqual([`private-${operatorId}`, "team-acme"].sort());

    expect(existsSync(repoDir("team-acme"))).toBe(false);
    expect(existsSync(repoDir(`private-${operatorId}`))).toBe(false);
    // core is the shared read-only pack - deleting one company must never touch it.
    expect(existsSync(repoDir("core"))).toBe(true);
  });

  it("frees the slug, so the same email comes back as itself and not as <slug>-2", async () => {
    await seedCompany("acme");
    await services.handler(del("acme"));
    // dedupeSlug only suffixes when the slug is taken; a real delete means it is not.
    const again = await services.handler(s2s("/s2s/companies", { id: "c2", slug: "acme", name: "acme" }));
    expect(again.status).toBe(201);
  });

  it("leaves a second company completely untouched", async () => {
    const a = await seedCompany("alpha");
    const b = await seedCompany("beta");
    await services.handler(del("alpha"));

    expect(existsSync(repoDir("team-alpha"))).toBe(false);
    expect(existsSync(repoDir(`private-${a.operatorId}`))).toBe(false);
    expect(existsSync(repoDir("team-beta"))).toBe(true);
    expect(existsSync(repoDir(`private-${b.operatorId}`))).toBe(true);
  });

  it("kills the deleted company's machine credentials - a stale token authenticates nothing", async () => {
    const { setupToken } = await seedCompany("acme");
    await services.handler(del("acme"));
    // The setup token was already consumed; re-presenting it must not resurrect anything either.
    const res = await services.handler(
      new Request("http://sync.test/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupToken, machineName: "laptop2" }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("404s an unknown slug rather than reporting a delete that never happened", async () => {
    const res = await services.handler(del("never-existed"));
    expect(res.status).toBe(404);
  });

  it("refuses without the service key", async () => {
    await seedCompany("acme");
    const res = await services.handler(del("acme", "wrong-key"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(repoDir("team-acme"))).toBe(true); // nothing deleted on a refused call
  });

  it("refuses a slug that could escape the repos root", async () => {
    const res = await services.handler(
      new Request("http://sync.test/s2s/companies/..%2F..%2Fetc", { method: "DELETE", headers: { "x-service-key": KEY } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
