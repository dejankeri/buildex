// The kept-work recovery routes, over a fake conflicts dep (the module itself has its own suite in
// sync/conflicts.test.ts) - this pins the wire shapes, the 404-vs-400 split, and that the routes
// stay optional (a boot that wires no conflicts dep still 404s them like any unknown path).
import { describe, it, expect } from "vitest";
import { createDaemon, type DaemonDeps } from "./daemon.js";
import { Gate } from "../gate/gate.js";
import { PolicyEngine, type PolicyPreset } from "../gate/policy.js";
import { ApprovalBroker } from "../gate/approval.js";

const preset: PolicyPreset = { allow: ["Read"], ask: [], deny: [], default: "ask" };

function makeDaemon(conflicts?: DaemonDeps["conflicts"]) {
  const broker = new ApprovalBroker({ idFactory: () => "c1", now: () => 0 });
  return createDaemon({
    workspace: "/ws",
    roots: [],
    gate: new Gate(new PolicyEngine(preset), broker),
    broker,
    async *runPrompt() {},
    buildMap: () => ({ nodes: [], edges: [] }),
    syncFn: async () => "ok",
    ...(conflicts ? { conflicts } : {}),
  });
}

/** A one-backup fake that records calls; `restore` flips the file to non-differing. */
function fakeConflicts() {
  const calls: string[] = [];
  let differs = true;
  let dismissed = false;
  const known = (root: string, stamp: string, file?: string) =>
    root === "team" && stamp === "1700" && (file === undefined || file === "doc.md");
  const dep: NonNullable<DaemonDeps["conflicts"]> = {
    list: () => (dismissed ? [] : [{ root: "team", stamp: "1700", at: 1700, files: [{ path: "doc.md", differs }] }]),
    read: (root, stamp, file) => {
      if (file.includes("..")) throw new Error(`path escapes the kept-work area: ${file}`);
      return known(root, stamp, file) ? { kept: "kept\n", current: "current\n" } : null;
    },
    restore: (root, stamp, file) => {
      if (file.includes("..")) throw new Error(`path escapes the kept-work area: ${file}`);
      calls.push(`restore ${root}/${stamp}/${file}`);
      if (!known(root, stamp, file)) return false;
      differs = false;
      return true;
    },
    dismiss: (root, stamp) => {
      calls.push(`dismiss ${root}/${stamp}`);
      if (!known(root, stamp)) return false;
      dismissed = true;
      return true;
    },
  };
  return { dep, calls };
}

const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/conflicts - what was kept", () => {
  it("lists the backups with per-file differs", async () => {
    const app = makeDaemon(fakeConflicts().dep);
    const res = await app(new Request("http://127.0.0.1/api/conflicts"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      conflicts: [{ root: "team", stamp: "1700", at: 1700, files: [{ path: "doc.md", differs: true }] }],
    });
  });

  it("stays a 404 when the dep is absent (the route is optional)", async () => {
    const app = makeDaemon();
    expect((await app(new Request("http://127.0.0.1/api/conflicts"))).status).toBe(404);
    expect((await app(post("/api/conflicts/restore", { root: "t", stamp: "1", file: "a" }))).status).toBe(404);
  });
});

describe("/api/conflicts/file - both sides for the side-by-side look", () => {
  it("returns kept + current for one file", async () => {
    const app = makeDaemon(fakeConflicts().dep);
    const res = await app(new Request("http://127.0.0.1/api/conflicts/file?root=team&stamp=1700&file=doc.md"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ root: "team", stamp: "1700", file: "doc.md", kept: "kept\n", current: "current\n" });
  });

  it("400s when a param is missing, 404s an unknown file, 400s an escaping path", async () => {
    const app = makeDaemon(fakeConflicts().dep);
    expect((await app(new Request("http://127.0.0.1/api/conflicts/file?root=team&stamp=1700"))).status).toBe(400);
    expect((await app(new Request("http://127.0.0.1/api/conflicts/file?root=team&stamp=9&file=doc.md"))).status).toBe(404);
    const escaped = await app(new Request("http://127.0.0.1/api/conflicts/file?root=team&stamp=1700&file=" + encodeURIComponent("../../secret")));
    expect(escaped.status).toBe(400);
    expect(((await escaped.json()) as { error: string }).error).toContain("escapes");
  });
});

describe("/api/conflicts/restore - copy the kept version back", () => {
  it("restores and the next list reports nothing left to bring back", async () => {
    const { dep, calls } = fakeConflicts();
    const app = makeDaemon(dep);
    const res = await app(post("/api/conflicts/restore", { root: "team", stamp: "1700", file: "doc.md" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual(["restore team/1700/doc.md"]);
    const list = (await (await app(new Request("http://127.0.0.1/api/conflicts"))).json()) as {
      conflicts: { files: { differs: boolean }[] }[];
    };
    expect(list.conflicts[0]!.files[0]!.differs).toBe(false);
  });

  it("404s an unknown stamp/file, 400s a missing field, 400s an escaping path", async () => {
    const app = makeDaemon(fakeConflicts().dep);
    expect((await app(post("/api/conflicts/restore", { root: "team", stamp: "9", file: "doc.md" }))).status).toBe(404);
    expect((await app(post("/api/conflicts/restore", { root: "team", stamp: "1700" }))).status).toBe(400);
    expect((await app(post("/api/conflicts/restore", { root: "team", stamp: "1700", file: "../x" }))).status).toBe(400);
  });
});

describe("/api/conflicts/dismiss - clear the flag, keep the backup", () => {
  it("dismisses and the backup drops out of the listing", async () => {
    const { dep, calls } = fakeConflicts();
    const app = makeDaemon(dep);
    const res = await app(post("/api/conflicts/dismiss", { root: "team", stamp: "1700" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual(["dismiss team/1700"]);
    expect(((await (await app(new Request("http://127.0.0.1/api/conflicts"))).json()) as { conflicts: unknown[] }).conflicts).toEqual([]);
  });

  it("404s an unknown backup and 400s a missing field", async () => {
    const app = makeDaemon(fakeConflicts().dep);
    expect((await app(post("/api/conflicts/dismiss", { root: "team", stamp: "9" }))).status).toBe(404);
    expect((await app(post("/api/conflicts/dismiss", { root: "team" }))).status).toBe(400);
  });
});
