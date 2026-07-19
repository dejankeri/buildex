import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Root } from "../brain/graph.js";
import type { ClientConfig } from "../wiring.js";
import type { Handler } from "../daemon/daemon.js";
import { OrgManager } from "./manager.js";
import { createOrgRouter } from "./router.js";

let root: string;
let stopCount = 0;
let builds: string[] = []; // workspaces built, in order
let gwHosts: { closed: boolean }[] = []; // one fake gateway host per build, in order
let gwCloseCount = 0;

const seedDemo = (ws: string): Root[] => {
  writeFileSync(join(ws, ".demo"), "1");
  return ["core", "team-acme", "private-you"].map((name) => ({ name, dir: join(ws, name) }));
};
const seedReal = (ws: string): Root[] => {
  writeFileSync(join(ws, ".real"), "1");
  return ["core", "team", "private"].map((name) => ({ name, dir: join(ws, name) }));
};

/** A stub daemon handler: echoes the org's workspace/company, simulates the sync scheduler, and hands
 *  back a fake connector-gateway host so the router's per-org gateway teardown is observable. */
const stubBuild = (config: ClientConfig): Handler => {
  builds.push(config.workspace);
  config.onScheduler?.({ start() {}, stop() { stopCount++; } } as unknown as Parameters<NonNullable<ClientConfig["onScheduler"]>>[0]);
  const host = { closed: false, close: async () => { host.closed = true; gwCloseCount++; } };
  gwHosts.push(host);
  config.onGatewayHost?.(Promise.resolve(host));
  return async () => new Response(JSON.stringify({ workspace: config.workspace, company: config.company }), { headers: { "content-type": "application/json" } });
};

const baseConfig = { preset: "standard", claudeBin: "claude" } as unknown as import("./router.js").OrgBaseConfig;

let ids: number;
function router() {
  ids = 0;
  const manager = new OrgManager({ orgsRoot: root, seedDemo, seedReal, idFactory: () => `org${++ids}`, now: () => ids });
  return createOrgRouter({ manager, baseConfig, buildHandler: stubBuild });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "buildex-orgrouter-"));
  stopCount = 0;
  builds = [];
  gwHosts = [];
  gwCloseCount = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("createOrgRouter", () => {
  it("boots into the operator's own empty org, with the Acme sandbox alongside", async () => {
    const r = router();
    expect(r.activeId()).toBe("org1"); // the auto-created "My Organization", not the demo
    const res = await r.handler(new Request("http://x/api/config"));
    const body = (await res.json()) as { workspace: string; company: { name: string } };
    expect(body.workspace).toContain(join("org1", "workspace"));
    expect(body.company.name).toBe("My Organization");
  });

  it("GET /api/orgs lists the operator's org first and the Acme sandbox alongside", async () => {
    const r = router();
    const res = await r.handler(new Request("http://x/api/orgs"));
    const body = (await res.json()) as { orgs: { id: string; name: string; sandbox: boolean }[]; activeId: string };
    expect(body.activeId).toBe("org1");
    expect(body.orgs).toEqual([
      { id: "org1", name: "My Organization", sandbox: false }, // real org leads
      { id: "demo", name: "Acme Labs", sandbox: true }, // demo sandbox alongside
    ]);
  });

  it("POST /api/orgs/create makes a real org, switches to it, and delegation follows", async () => {
    const r = router();
    const res = await r.handler(
      new Request("http://x/api/orgs/create", { method: "POST", body: JSON.stringify({ name: "My Startup" }) }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(r.activeId()).toBe(id);

    // delegation now targets the new org's workspace
    const cfg = (await (await r.handler(new Request("http://x/api/config"))).json()) as { workspace: string; company: { name: string } };
    expect(cfg.workspace).toContain(join(id, "workspace"));
    expect(cfg.company.name).toBe("My Startup");

    // listing shows real orgs first (newest first), demo last, active = the new org. "org1" is the
    // auto-created "My Organization" from first-run bootstrap; the just-created org sorts ahead of it.
    const list = (await (await r.handler(new Request("http://x/api/orgs"))).json()) as { orgs: { id: string }[]; activeId: string };
    expect(list.activeId).toBe(id);
    expect(list.orgs.map((o) => o.id)).toEqual([id, "org1", "demo"]);
  });

  it("POST /api/orgs/switch tears down the previous sync loop and rebinds", async () => {
    const r = router();
    const created = (await (await r.handler(new Request("http://x/api/orgs/create", { method: "POST", body: JSON.stringify({ name: "Real" }) }))).json()) as { id: string };
    const stopsBefore = stopCount;

    const res = await r.handler(new Request("http://x/api/orgs/switch", { method: "POST", body: JSON.stringify({ id: "demo" }) }));
    expect(res.status).toBe(200);
    expect(r.activeId()).toBe("demo");
    expect(stopCount).toBe(stopsBefore + 1); // the previous (created) org's scheduler was stopped

    const cfg = (await (await r.handler(new Request("http://x/api/config"))).json()) as { company: { name: string } };
    expect(cfg.company.name).toBe("Acme Labs");
    expect(created.id).not.toBe("demo");
  });

  it("rejects a switch to an unknown org and a create with no name", async () => {
    const r = router();
    expect((await r.handler(new Request("http://x/api/orgs/switch", { method: "POST", body: JSON.stringify({ id: "nope" }) }))).status).toBe(404);
    expect((await r.handler(new Request("http://x/api/orgs/create", { method: "POST", body: JSON.stringify({ name: "  " }) }))).status).toBe(400);
  });

  it("close() stops the active sync loop and closes its gateway host", async () => {
    const r = router();
    const before = stopCount;
    await r.close();
    expect(stopCount).toBe(before + 1);
    expect(gwCloseCount).toBe(1); // the active org's gateway host was closed
    expect(gwHosts[gwHosts.length - 1]!.closed).toBe(true);
  });

  it("closes the previous org's gateway host before rebinding on switch (the fixed port is freed)", async () => {
    const r = router(); // boots "org1" with gateway host gwHosts[0]
    expect(gwCloseCount).toBe(0);
    const res = await r.handler(new Request("http://x/api/orgs/switch", { method: "POST", body: JSON.stringify({ id: "demo" }) }));
    expect(res.status).toBe(200);
    expect(gwHosts[0]!.closed).toBe(true); // org1's gateway host was torn down...
    expect(gwCloseCount).toBe(1);
    expect(gwHosts.length).toBe(2); // ...before the demo org's gateway host was built
  });

  it("creating a new org also tears down the previous org's gateway host", async () => {
    const r = router();
    const res = await r.handler(new Request("http://x/api/orgs/create", { method: "POST", body: JSON.stringify({ name: "Fresh" }) }));
    expect(res.status).toBe(201);
    expect(gwHosts[0]!.closed).toBe(true); // org1's gateway released before the new org's was built
  });

  it("a gateway host that never bound (rejected) doesn't break switching", async () => {
    // A build whose gateway promise REJECTS (bind failure) - teardown must swallow it, not throw.
    const manager = new OrgManager({ orgsRoot: root, seedDemo, seedReal, idFactory: () => "orgX", now: () => 1 });
    const failBuild = (config: ClientConfig): Handler => {
      config.onScheduler?.({ start() {}, stop() {} } as unknown as Parameters<NonNullable<ClientConfig["onScheduler"]>>[0]);
      config.onGatewayHost?.(Promise.reject(new Error("EADDRINUSE")));
      return async () => new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const r = createOrgRouter({ manager, baseConfig, buildHandler: failBuild });
    const res = await r.handler(new Request("http://x/api/orgs/switch", { method: "POST", body: JSON.stringify({ id: "demo" }) }));
    expect(res.status).toBe(200); // switch still succeeds despite the dead gateway
    await r.close(); // and close doesn't throw either
  });
});
