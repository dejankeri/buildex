import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { provisionLocalWorkspace, isFirstRun, ensureLocalWorkspace } from "./local-workspace.js";
import { SyncEngine } from "../sync/engine.js";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "buildex-ws-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A minimal valid core pack on disk. */
function fakePack(): string {
  const dir = join(tmp, "pack");
  mkdirSync(join(dir, "rules"), { recursive: true });
  writeFileSync(join(dir, "rules", "operating.md"), "# core operating rules\n");
  return dir;
}

describe("isFirstRun - a fresh install has no provisioned workspace yet", () => {
  it("is true before provisioning and false after", () => {
    const ws = join(tmp, "ws");
    expect(isFirstRun(ws)).toBe(true);
    provisionLocalWorkspace({ workspace: ws, corePackDir: fakePack() });
    expect(isFirstRun(ws)).toBe(false);
  });
});

describe("provisionLocalWorkspace - empty-starter local stubs, no remotes", () => {
  it("creates core + team + private as local git repos and returns them in precedence order", () => {
    const ws = join(tmp, "ws");
    const roots = provisionLocalWorkspace({ workspace: ws, corePackDir: fakePack() });

    expect(roots.map((r) => r.name)).toEqual(["core", "team", "private"]);
    for (const r of roots) {
      expect(existsSync(join(r.dir, ".git"))).toBe(true);
      expect(git(["remote"], r.dir)).toBe(""); // no account yet → no remote
      expect(git(["log", "-1", "--pretty=%s"], r.dir).length).toBeGreaterThan(0); // has a seed commit
    }
  });

  it("seeds an EMPTY starter - a welcome only, never fake company data", () => {
    const ws = join(tmp, "ws");
    provisionLocalWorkspace({ workspace: ws, corePackDir: fakePack() });
    // team/private carry a starter file so the workspace isn't literally empty…
    expect(existsSync(join(ws, "team", "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(ws, "private", "notes.md"))).toBe(true);
    // …but none of the demo's Acme sample data leaks into a real operator's workspace
    expect(existsSync(join(ws, "team", "clients"))).toBe(false);
    expect(existsSync(join(ws, "team", "finance"))).toBe(false);
  });

  it("every writable stub drives the sync engine to the neutral 'local' state", async () => {
    const ws = join(tmp, "ws");
    const roots = provisionLocalWorkspace({ workspace: ws, corePackDir: fakePack() });
    const engine = new SyncEngine({ now: () => 1_700_000_000_000, actor: "operator" });
    for (const r of roots.filter((x) => x.name !== "core")) {
      expect(await engine.syncWritable(r.dir)).toBe("local");
    }
  });

  it("ensureLocalWorkspace provisions on first run, then returns roots WITHOUT needing the pack again", () => {
    const ws = join(tmp, "ws");
    const first = ensureLocalWorkspace({ workspace: ws, corePackDir: fakePack() });
    expect(first.map((r) => r.name)).toEqual(["core", "team", "private"]);

    // a booted app after first run must not depend on the bundled pack being present
    const again = ensureLocalWorkspace({ workspace: ws });
    expect(again).toEqual(first);
  });

  it("ensureLocalWorkspace on a first run WITHOUT a pack fails loudly (can't provision core from nothing)", () => {
    expect(() => ensureLocalWorkspace({ workspace: join(tmp, "empty") })).toThrow(/core pack/i);
  });

  it("is idempotent - re-provisioning preserves operator work in the stubs", () => {
    const ws = join(tmp, "ws");
    provisionLocalWorkspace({ workspace: ws, corePackDir: fakePack() });
    writeFileSync(join(ws, "private", "secret-plan.md"), "keep me\n");
    provisionLocalWorkspace({ workspace: ws, corePackDir: fakePack() });
    expect(existsSync(join(ws, "private", "secret-plan.md"))).toBe(true);
  });
});
