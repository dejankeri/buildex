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

const seedDemo = (ws: string): Root[] => {
  writeFileSync(join(ws, ".demo"), "1");
  return ["core", "team-acme", "private-you"].map((name) => ({ name, dir: join(ws, name) }));
};
const seedReal = (ws: string): Root[] => {
  writeFileSync(join(ws, ".real"), "1");
  return ["core", "team", "private"].map((name) => ({ name, dir: join(ws, name) }));
};

/** A stub daemon handler: echoes the org's workspace/company and simulates the sync scheduler. */
const stubBuild = (config: ClientConfig): Handler => {
  builds.push(config.workspace);
  config.onScheduler?.({ start() {}, stop() { stopCount++; } } as unknown as Parameters<NonNullable<ClientConfig["onScheduler"]>>[0]);
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
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("createOrgRouter", () => {
  it("boots into the demo sandbox and delegates there", async () => {
    const r = router();
    expect(r.activeId()).toBe("demo");
    const res = await r.handler(new Request("http://x/api/config"));
    const body = (await res.json()) as { workspace: string; company: { name: string } };
    expect(body.workspace).toContain(join("demo", "workspace"));
    expect(body.company.name).toBe("Acme Labs");
  });

  it("GET /api/orgs lists the demo with its sandbox flag", async () => {
    const r = router();
    const res = await r.handler(new Request("http://x/api/orgs"));
    const body = (await res.json()) as { orgs: { id: string; name: string; sandbox: boolean }[]; activeId: string };
    expect(body.activeId).toBe("demo");
    expect(body.orgs).toEqual([{ id: "demo", name: "Acme Labs", sandbox: true }]);
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

    // listing shows real first, demo last, active = the new org
    const list = (await (await r.handler(new Request("http://x/api/orgs"))).json()) as { orgs: { id: string }[]; activeId: string };
    expect(list.activeId).toBe(id);
    expect(list.orgs.map((o) => o.id)).toEqual([id, "demo"]);
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

  it("close() stops the active sync loop", () => {
    const r = router();
    const before = stopCount;
    r.close();
    expect(stopCount).toBe(before + 1);
  });
});
