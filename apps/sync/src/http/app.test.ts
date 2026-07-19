import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneStore } from "../store/store.js";
import { EmbeddedGitService } from "../git/service.js";
import { ProvisioningService } from "../provisioning/service.js";
import { ScheduleStore } from "../automations/schedule-store.js";
import { createApp } from "./app.js";

const SERVICE_KEY = "svc-secret-key";
let dir: string;
let store: ControlPlaneStore;
let app: (req: Request) => Promise<Response>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "buildex-app-"));
  store = new ControlPlaneStore(join(dir, "control.db"));
  const git = new EmbeddedGitService({ reposRoot: join(dir, "repos") });
  let n = 0;
  const provisioning = new ProvisioningService({ store, git, idFactory: () => `m${++n}` });
  await provisioning.ensureCoreRepo();
  const schedules = new ScheduleStore(join(dir, "schedules.db"));
  app = createApp({ store, provisioning, git, schedules, serviceKey: SERVICE_KEY, publicBaseUrl: "https://sync.test" });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://sync.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const s2s = (path: string, body: unknown) => json(path, body, { "x-service-key": SERVICE_KEY });
const basic = (token: string) => "Basic " + Buffer.from(`x:${token}`).toString("base64");

/** Provision a fresh operator+machine end-to-end through the S2S + provision API. */
async function provisionOperator(): Promise<{ machineToken: string; refreshToken: string }> {
  await app(s2s("/s2s/companies", { id: "c1", slug: "acme", name: "Acme" }));
  await app(s2s("/s2s/operators", { id: "o1", companyId: "c1", email: "a@acme.com" }));
  const mintRes = await app(s2s("/s2s/setup-tokens", { operatorId: "o1" }));
  const { setupToken } = (await mintRes.json()) as { setupToken: string };
  const provRes = await app(json("/provision", { setupToken, machineName: "laptop" }));
  return (await provRes.json()) as { machineToken: string; refreshToken: string };
}

describe("healthz", () => {
  it("returns ok", async () => {
    const res = await app(new Request("https://sync.test/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("S2S service-key gate (timing-safe)", () => {
  it("rejects a missing/wrong service key with 401", async () => {
    const bad = await app(json("/s2s/companies", { id: "c1", slug: "acme", name: "Acme" }, { "x-service-key": "wrong" }));
    expect(bad.status).toBe(401);
    const missing = await app(json("/s2s/companies", { id: "c1", slug: "acme", name: "Acme" }));
    expect(missing.status).toBe(401);
  });

  it("accepts the correct service key", async () => {
    const ok = await app(s2s("/s2s/companies", { id: "c1", slug: "acme", name: "Acme" }));
    expect(ok.status).toBe(201);
  });
});

describe("provision → credentials with clone URLs", () => {
  it("returns machine + refresh tokens and the three repo clone URLs", async () => {
    const creds = (await provisionOperator()) as unknown as {
      machineToken: string; refreshToken: string; repos: Record<string, string>;
    };
    expect(creds.machineToken.startsWith("xmachine_")).toBe(true);
    expect(creds.refreshToken.startsWith("xrefresh_")).toBe(true);
    expect(creds.repos).toEqual({
      core: "https://sync.test/git/core.git",
      team: "https://sync.test/git/team-acme.git",
      private: "https://sync.test/git/private-o1.git",
    });
  });

  it("rejects a reused setup token", async () => {
    await app(s2s("/s2s/companies", { id: "c1", slug: "acme", name: "Acme" }));
    await app(s2s("/s2s/operators", { id: "o1", companyId: "c1", email: "a@acme.com" }));
    const { setupToken } = (await (await app(s2s("/s2s/setup-tokens", { operatorId: "o1" }))).json()) as { setupToken: string };
    expect((await app(json("/provision", { setupToken, machineName: "a" }))).status).toBe(200);
    expect((await app(json("/provision", { setupToken, machineName: "b" }))).status).toBe(401);
  });
});

describe("git smart-HTTP + permission-matrix invariant (through the real handler)", () => {
  it("allows an operator to READ core", async () => {
    const { machineToken } = await provisionOperator();
    const res = await app(
      new Request("https://sync.test/git/core.git/info/refs?service=git-upload-pack", {
        headers: { authorization: basic(machineToken) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("# service=git-upload-pack");
  });

  it("REJECTS a non-admin push to core with 403", async () => {
    const { machineToken } = await provisionOperator();
    const res = await app(
      new Request("https://sync.test/git/core.git/info/refs?service=git-receive-pack", {
        headers: { authorization: basic(machineToken) },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("allows a push to the team repo", async () => {
    const { machineToken } = await provisionOperator();
    const res = await app(
      new Request("https://sync.test/git/team-acme.git/info/refs?service=git-receive-pack", {
        headers: { authorization: basic(machineToken) },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a request with no credentials (401)", async () => {
    await provisionOperator();
    const res = await app(new Request("https://sync.test/git/core.git/info/refs?service=git-upload-pack"));
    expect(res.status).toBe(401);
  });

  it("a revoked operator loses read+write within one request (401)", async () => {
    const { machineToken } = await provisionOperator();
    await app(s2s("/s2s/revoke", { operatorId: "o1" }));
    const res = await app(
      new Request("https://sync.test/git/core.git/info/refs?service=git-upload-pack", {
        headers: { authorization: basic(machineToken) },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("token refresh", () => {
  it("rotates credentials and invalidates the old machine token", async () => {
    const { machineToken, refreshToken } = await provisionOperator();
    const rotated = (await (await app(json("/token/refresh", { refreshToken }))).json()) as { machineToken: string };
    expect(rotated.machineToken).not.toBe(machineToken);

    // the OLD machine token no longer authorizes
    const old = await app(
      new Request("https://sync.test/git/core.git/info/refs?service=git-upload-pack", {
        headers: { authorization: basic(machineToken) },
      }),
    );
    expect(old.status).toBe(401);
  });
});
