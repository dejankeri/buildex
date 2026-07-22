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
let schedules: ScheduleStore;
let git: EmbeddedGitService;
let provisioning: ProvisioningService;
let app: (req: Request) => Promise<Response>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "buildex-app-"));
  store = new ControlPlaneStore(join(dir, "control.db"));
  git = new EmbeddedGitService({ reposRoot: join(dir, "repos") });
  let n = 0;
  provisioning = new ProvisioningService({ store, git, idFactory: () => `m${++n}` });
  await provisioning.ensureCoreRepo();
  schedules = new ScheduleStore(join(dir, "schedules.db"));
  app = createApp({ store, provisioning, git, schedules, serviceKey: SERVICE_KEY, publicBaseUrl: "https://sync.test" });
});
afterEach(() => {
  store.close();
  schedules.close();
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

describe("POST /session (Supabase sign-in, dormant-safe)", () => {
  it("501s when verifySession is not configured (dormant default) and provisions nothing", async () => {
    const res = await app(json("/session", { jwt: "whatever" }));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "sign-in not configured" });
  });

  it("501s (not 400) on a dormant /session with an empty body - the dormant check runs before jwt validation", async () => {
    const res = await app(json("/session", {}));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "sign-in not configured" });
  });

  it("verifies the session and provisions a company-of-one, same shape as /provision", async () => {
    const sessionApp = createApp({
      store,
      provisioning,
      git,
      schedules,
      serviceKey: SERVICE_KEY,
      publicBaseUrl: "https://sync.test",
      verifySession: async () => ({ sub: "s1", email: "a@acme.io" }),
    });
    const res = await sessionApp(json("/session", { jwt: "good-jwt" }));
    expect(res.status).toBe(200);
    const creds = (await res.json()) as { machineToken: string; refreshToken: string; repos: Record<string, string> };
    expect(creds.machineToken.startsWith("xmachine_")).toBe(true);
    expect(creds.refreshToken.startsWith("xrefresh_")).toBe(true);
    expect(creds.repos).toEqual({
      core: "https://sync.test/git/core.git",
      team: expect.stringMatching(/^https:\/\/sync\.test\/git\/team-.+\.git$/) as unknown as string,
      private: expect.stringMatching(/^https:\/\/sync\.test\/git\/private-.+\.git$/) as unknown as string,
    });

    // idempotent: the same sub resolves to the same operator/company on a second sign-in
    const again = await sessionApp(json("/session", { jwt: "good-jwt-2" }));
    expect(again.status).toBe(200);
    expect(store.findOperatorBySupabaseSub("s1")).not.toBeNull();
  });

  it("401s on a rejected JWT and NEVER provisions - a rejected session must not create a company", async () => {
    let provisionCalls = 0;
    const spiedProvisioning = new Proxy(provisioning, {
      get(target, prop, receiver) {
        if (prop === "provisionBySession") {
          return async (...args: Parameters<ProvisioningService["provisionBySession"]>) => {
            provisionCalls++;
            return target.provisionBySession(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const sessionApp = createApp({
      store,
      provisioning: spiedProvisioning,
      git,
      schedules,
      serviceKey: SERVICE_KEY,
      publicBaseUrl: "https://sync.test",
      verifySession: async () => {
        throw new Error("bad signature");
      },
    });
    const res = await sessionApp(json("/session", { jwt: "bad-jwt" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "sign-in failed" });
    expect(provisionCalls).toBe(0);
    expect(store.findOperatorBySupabaseSub("s1")).toBeNull();
  });

  it("400s on a missing/empty jwt in the body", async () => {
    const sessionApp = createApp({
      store,
      provisioning,
      git,
      schedules,
      serviceKey: SERVICE_KEY,
      publicBaseUrl: "https://sync.test",
      verifySession: async () => ({ sub: "s1" }),
    });
    expect((await sessionApp(json("/session", {}))).status).toBe(400);
    expect((await sessionApp(json("/session", { jwt: "" }))).status).toBe(400);
  });

  it("404s on GET /session, matching /provision's convention for the wrong method", async () => {
    const res = await app(new Request("https://sync.test/session"));
    expect(res.status).toBe(404);
  });
});
