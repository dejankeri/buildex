import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Root } from "../brain/graph.js";
import { OrgManager, DEMO_ORG_ID } from "./manager.js";

let root: string;
let demoSeeds = 0;
let realSeeds = 0;

/** Stub seeders: mark the workspace so we can prove they ran, and return fixed roots. */
const seedDemo = (workspace: string): Root[] => {
  demoSeeds++;
  writeFileSync(join(workspace, ".demo-seeded"), "1");
  return ["core", "team-acme", "private-you"].map((name) => ({ name, dir: join(workspace, name) }));
};
const seedReal = (workspace: string): Root[] => {
  realSeeds++;
  writeFileSync(join(workspace, ".real-seeded"), "1");
  return ["core", "team", "private"].map((name) => ({ name, dir: join(workspace, name) }));
};

let ids: number;
const make = () =>
  new OrgManager({ orgsRoot: root, seedDemo, seedReal, idFactory: () => `org${++ids}`, now: () => 1000 + ids });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "buildex-orgs-"));
  demoSeeds = 0;
  realSeeds = 0;
  ids = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("OrgManager", () => {
  it("ensureDemo creates the sandbox org (local-only, marked)", () => {
    const mgr = make();
    const demo = mgr.ensureDemo();
    expect(demo.id).toBe(DEMO_ORG_ID);
    expect(demo.name).toBe("Acme Labs");
    expect(demo.sandbox).toBe(true);
    expect(demo.rootNames).toEqual(["core", "team-acme", "private-you"]);
    expect(demoSeeds).toBe(1);
    expect(existsSync(join(demo.workspace, ".demo-seeded"))).toBe(true);
    // roots resolve to <workspace>/<name>
    expect(demo.roots[0]).toEqual({ name: "core", dir: join(demo.workspace, "core") });
  });

  it("ensureDemo is idempotent - never re-seeds an existing demo", () => {
    const mgr = make();
    const a = mgr.ensureDemo();
    const b = mgr.ensureDemo();
    expect(b.id).toBe(a.id);
    expect(demoSeeds).toBe(1); // seeded once, not twice
  });

  it("create() makes a real org and makes it active", () => {
    const mgr = make();
    mgr.ensureDemo();
    const real = mgr.create({ name: "My Startup" });
    expect(real.sandbox).toBe(false);
    expect(real.name).toBe("My Startup");
    expect(real.rootNames).toEqual(["core", "team", "private"]);
    expect(realSeeds).toBe(1);
    expect(mgr.active()?.id).toBe(real.id);
  });

  it("create() rejects an empty name", () => {
    const mgr = make();
    expect(() => mgr.create({ name: "   " })).toThrow();
  });

  it("list() returns real orgs first, the demo last", () => {
    const mgr = make();
    mgr.ensureDemo();
    const r1 = mgr.create({ name: "First" });
    const r2 = mgr.create({ name: "Second" });
    const list = mgr.list();
    expect(list.map((o) => o.id)).toEqual([r2.id, r1.id, DEMO_ORG_ID]); // real newest-first, demo last
  });

  it("active() honors the pointer and falls back when it dangles", () => {
    const mgr = make();
    const demo = mgr.ensureDemo();
    const real = mgr.create({ name: "Real" }); // create sets active → real
    expect(mgr.active()?.id).toBe(real.id);

    mgr.setActive(demo.id);
    expect(mgr.active()?.id).toBe(demo.id);

    // a dangling pointer (org removed) falls back to the first listed org, never crashes
    writeFileSync(join(root, "active-org"), "does-not-exist");
    expect(mgr.active()?.id).toBe(real.id); // real sorts first
  });

  it("setActive rejects an unknown org; get() returns null for one", () => {
    const mgr = make();
    mgr.ensureDemo();
    expect(() => mgr.setActive("nope")).toThrow();
    expect(mgr.get("nope")).toBeNull();
  });

  it("list() skips a corrupt org.json instead of crashing", () => {
    const mgr = make();
    mgr.ensureDemo();
    const bad = join(root, "broken");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "org.json"), "{ not valid json");
    const list = mgr.list();
    expect(list.map((o) => o.id)).toEqual([DEMO_ORG_ID]); // only the good one
  });

  it("persists org.json with the expected shape", () => {
    const mgr = make();
    const demo = mgr.ensureDemo();
    const raw = JSON.parse(readFileSync(join(demo.dir, "org.json"), "utf8"));
    expect(raw).toMatchObject({ id: DEMO_ORG_ID, name: "Acme Labs", sandbox: true });
    expect(raw.rootNames).toEqual(["core", "team-acme", "private-you"]);
    expect(typeof raw.createdAt).toBe("number");
  });
});
