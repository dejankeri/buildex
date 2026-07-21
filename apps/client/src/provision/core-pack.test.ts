import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveCorePackDir, provisionLocalCore } from "./core-pack.js";
import { SyncEngine } from "../sync/engine.js";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "buildex-corepack-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A minimal but valid core pack on disk (the marker file every pack carries + a skill). */
function fakePack(): string {
  const dir = join(tmp, "pack");
  mkdirSync(join(dir, "rules"), { recursive: true });
  mkdirSync(join(dir, "skills", "tidy"), { recursive: true });
  writeFileSync(join(dir, "rules", "operating.md"), "# core operating rules\n");
  writeFileSync(join(dir, "skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: Use when …\n---\n# tidy\n");
  return dir;
}

describe("resolveCorePackDir - locate the bundled pack (packaged vs dev)", () => {
  it("prefers the packaged resources path when it carries a real pack", () => {
    // Build the fake-exists keys with join() so they match the resolver's own (win32-joined) probe
    // strings on Windows - the marker it checks is <dir>/rules/operating.md.
    const packaged = join("/res", "core-pack");
    const inRepo = join("/repo", "packs", "core");
    const seen = new Set([join(packaged, "rules", "operating.md"), join(inRepo, "rules", "operating.md")]);
    const dir = resolveCorePackDir({ resourcesPath: "/res", repoRoot: "/repo", exists: (p) => seen.has(p) });
    expect(dir).toBe(packaged);
  });

  it("falls back to the in-repo packs/core in dev when there is no packaged pack", () => {
    const inRepo = join("/repo", "packs", "core");
    const seen = new Set([join(inRepo, "rules", "operating.md")]);
    const dir = resolveCorePackDir({ repoRoot: "/repo", exists: (p) => seen.has(p) });
    expect(dir).toBe(inRepo);
  });

  it("throws (never provisions an empty core) when no candidate carries a pack", () => {
    expect(() => resolveCorePackDir({ resourcesPath: "/res", repoRoot: "/repo", exists: () => false })).toThrow(/core pack not found/i);
  });
});

describe("provisionLocalCore - lay core down as a local, no-remote git repo (zero network)", () => {
  it("creates workspace/core with the pack content, an initial commit, and NO remote", () => {
    const ws = join(tmp, "ws");
    const root = provisionLocalCore({ workspace: ws, corePackDir: fakePack() });

    expect(root).toEqual({ name: "core", dir: join(ws, "core") });
    // pack content is present
    expect(existsSync(join(ws, "core", "skills", "tidy", "SKILL.md"))).toBe(true);
    // CLAUDE.md was assembled from the pack's operating rules (matches demo-setup)
    expect(readFileSync(join(ws, "core", "CLAUDE.md"), "utf8")).toContain("core operating rules");
    // it is a real git repo with a commit
    expect(git(["log", "-1", "--pretty=%s"], join(ws, "core"))).toContain("core");
    // and crucially: NO remote (self-serve, no account yet)
    expect(git(["remote"], join(ws, "core"))).toBe("");
  });

  it("is idempotent - a second call leaves an existing core untouched (never clobbers work)", () => {
    const ws = join(tmp, "ws2");
    provisionLocalCore({ workspace: ws, corePackDir: fakePack() });
    // an operator-made marker inside core must survive a re-provision
    writeFileSync(join(ws, "core", "MINE.md"), "do not delete\n");
    provisionLocalCore({ workspace: ws, corePackDir: fakePack() });
    expect(existsSync(join(ws, "core", "MINE.md"))).toBe(true);
  });

  it("the provisioned local core drives the sync engine to the neutral 'local' state (ties #1 to #3)", async () => {
    const ws = join(tmp, "ws3");
    const root = provisionLocalCore({ workspace: ws, corePackDir: fakePack() });
    const engine = new SyncEngine({ now: () => 1_700_000_000_000, actor: "operator" });
    expect(await engine.syncWritable(root.dir)).toBe("local");
  });
});
