import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Conflicts, type ConflictsFs } from "./conflicts.js";
import { SyncEngine } from "./engine.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "buildex-conflicts-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const MARKER_LINE = (stamp: string) =>
  `Conflict at ${stamp}. Your version was saved under .conflicts/${stamp}/ - nothing was lost.\n`;

/** A repo dir with one kept backup, laid out exactly as engine.backupAndReset leaves it. */
function seedBackup(name: string, stamp: string, files: Record<string, string>, current: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, ".conflicts", stamp, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  for (const [rel, content] of Object.entries(current)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  writeFileSync(join(dir, ".sync-needs-help"), MARKER_LINE(stamp), { flag: "a" });
  return dir;
}

describe("Conflicts.list - what was kept, and whether it still differs", () => {
  it("lists a backup's files with per-file differs, only while the marker is present", () => {
    const dir = seedBackup(
      "team",
      "1700000000000",
      { "doc.md": "mine\n", "notes/plan.md": "my plan\n" },
      { "doc.md": "theirs\n", "notes/plan.md": "my plan\n" },
    );
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.list()).toEqual([
      {
        root: "team",
        stamp: "1700000000000",
        at: 1700000000000,
        files: [
          { path: "doc.md", differs: true },
          { path: "notes/plan.md", differs: false }, // identical bytes - nothing left to bring back
        ],
      },
    ]);

    // Dismissing clears the listing... but the backup dir itself stays on disk (invariant 8).
    expect(c.dismiss("team", "1700000000000")).toBe(true);
    expect(c.list()).toEqual([]);
    expect(existsSync(join(dir, ".conflicts", "1700000000000", "doc.md"))).toBe(true);
  });

  it("a missing current file counts as differing - there is plainly something to bring back", () => {
    const dir = seedBackup("team", "1", { "gone.md": "kept\n" }, {});
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.list()[0]!.files).toEqual([{ path: "gone.md", differs: true }]);
  });

  it("lists two backups (newest first) when a second conflict landed before the first was dismissed", () => {
    const dir = seedBackup("team", "1000", { "a.md": "v1\n" }, { "a.md": "team\n" });
    seedBackup("team", "2000", { "a.md": "v2\n" }, {}); // appends a second marker line
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.list().map((b) => b.stamp)).toEqual(["2000", "1000"]);

    // Dismissing one leaves the other still asking for attention.
    expect(c.dismiss("team", "2000")).toBe(true);
    expect(c.list().map((b) => b.stamp)).toEqual(["1000"]);
    expect(c.hasAttention()).toBe(true);
    expect(c.dismiss("team", "1000")).toBe(true);
    expect(c.hasAttention()).toBe(false);
  });

  it("falls back to every backup dir on disk when the marker names no stamp (never hide kept work)", () => {
    const dir = seedBackup("team", "3000", { "doc.md": "kept\n" }, {});
    writeFileSync(join(dir, ".sync-needs-help"), "something went wrong\n"); // hand-mangled marker
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.list().map((b) => b.stamp)).toEqual(["3000"]);
  });

  it("reports nothing for a root with no marker, even if old (dismissed) backups exist", () => {
    const dir = seedBackup("team", "1", { "doc.md": "kept\n" }, {});
    new Conflicts({ roots: [{ name: "team", dir }] }).dismiss("team", "1");
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.list()).toEqual([]);
    expect(c.hasAttention()).toBe(false);
  });
});

describe("Conflicts.read - both sides of one kept file", () => {
  it("returns the kept and current content", () => {
    const dir = seedBackup("team", "1", { "doc.md": "kept\n" }, { "doc.md": "current\n" });
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.read("team", "1", "doc.md")).toEqual({ kept: "kept\n", current: "current\n" });
  });

  it("returns current:null when the workspace file no longer exists", () => {
    const dir = seedBackup("team", "1", { "gone.md": "kept\n" }, {});
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.read("team", "1", "gone.md")).toEqual({ kept: "kept\n", current: null });
  });

  it("returns null for an unknown root, stamp, or file (the routes' 404)", () => {
    const dir = seedBackup("team", "1", { "doc.md": "kept\n" }, {});
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.read("nope", "1", "doc.md")).toBeNull();
    expect(c.read("team", "9", "doc.md")).toBeNull();
    expect(c.read("team", "1", "other.md")).toBeNull();
  });
});

describe("Conflicts.restore - copy the kept version back as an ordinary edit", () => {
  it("overwrites the current file, reports the repo dir, and leaves the backup untouched", () => {
    const dir = seedBackup("team", "1", { "doc.md": "kept\n" }, { "doc.md": "current\n" });
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.restore("team", "1", "doc.md")).toEqual({ dir });
    expect(readFileSync(join(dir, "doc.md"), "utf8")).toBe("kept\n");
    expect(readFileSync(join(dir, ".conflicts", "1", "doc.md"), "utf8")).toBe("kept\n");
    // ...and the listing now shows nothing left to bring back.
    expect(c.list()[0]!.files).toEqual([{ path: "doc.md", differs: false }]);
  });

  it("recreates missing parent folders (the current file may have been deleted, dir and all)", () => {
    const dir = seedBackup("team", "1", { "notes/deep/plan.md": "kept\n" }, {});
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.restore("team", "1", "notes/deep/plan.md")).toEqual({ dir });
    expect(readFileSync(join(dir, "notes", "deep", "plan.md"), "utf8")).toBe("kept\n");
  });

  it("returns null when there is no such kept file", () => {
    const dir = seedBackup("team", "1", { "doc.md": "kept\n" }, {});
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.restore("team", "1", "never-kept.md")).toBeNull();
  });
});

describe("Conflicts.dismiss - clears the flag, never the backup", () => {
  it("returns false for an unknown root or a stamp with no backup dir", () => {
    const dir = seedBackup("team", "1", { "doc.md": "kept\n" }, {});
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.dismiss("nope", "1")).toBe(false);
    expect(c.dismiss("team", "9")).toBe(false);
    expect(existsSync(join(dir, ".sync-needs-help"))).toBe(true); // nothing was cleared
  });

  it("is idempotent: dismissing an already-dismissed backup is success", () => {
    const dir = seedBackup("team", "1", { "doc.md": "kept\n" }, {});
    const c = new Conflicts({ roots: [{ name: "team", dir }] });
    expect(c.dismiss("team", "1")).toBe(true);
    expect(c.dismiss("team", "1")).toBe(true);
  });
});

describe("path confinement - root/stamp/file arrive from HTTP and must never escape", () => {
  const setup = () => {
    const dir = seedBackup("team", "1", { "doc.md": "kept\n" }, { "doc.md": "current\n" });
    writeFileSync(join(root, "outside.md"), "secret\n");
    return { dir, c: new Conflicts({ roots: [{ name: "team", dir }] }) };
  };

  it("refuses a stamp that is not a plain epoch-ms string", () => {
    const { c } = setup();
    expect(() => c.read("team", "../1", "doc.md")).toThrow(/invalid backup stamp/);
    expect(() => c.restore("team", "..", "doc.md")).toThrow(/invalid backup stamp/);
    expect(() => c.dismiss("team", "../../etc")).toThrow(/invalid backup stamp/);
  });

  it("refuses a file that traverses out of the backup dir", () => {
    const { c } = setup();
    expect(() => c.read("team", "1", "../../../outside.md")).toThrow(/escapes/);
    expect(() => c.restore("team", "1", "../../../outside.md")).toThrow(/escapes/);
  });

  it("refuses an absolute file path", () => {
    const { c } = setup();
    expect(() => c.read("team", "1", join(root, "outside.md"))).toThrow(/escapes/);
  });

  it("refuses any path that names .git", () => {
    const { dir, c } = setup();
    mkdirSync(join(dir, ".conflicts", "1", ".git"), { recursive: true });
    writeFileSync(join(dir, ".conflicts", "1", ".git", "config"), "planted\n");
    expect(() => c.restore("team", "1", ".git/config")).toThrow(/\.git/);
  });
});

describe("injected fs - the module runs against any filesystem surface", () => {
  it("hasAttention consults only the injected fs", () => {
    const seen: string[] = [];
    const fakeFs = {
      existsSync: (p: string) => {
        seen.push(p);
        return p.endsWith(".sync-needs-help");
      },
    } as unknown as ConflictsFs;
    const c = new Conflicts({ roots: [{ name: "team", dir: "/nowhere/team" }], fs: fakeFs });
    expect(c.hasAttention()).toBe(true);
    expect(seen).toEqual([join("/nowhere/team", ".sync-needs-help")]);
  });
});

// --- The real thing: the engine's conflict path, then this module over its actual layout --------
// Real git in a tmpdir (like engine.test.ts): two clones diverge, the engine backs up and resets,
// and the recovery surface must find exactly what was kept - the seam this module exists to serve.

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
} as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

describe("after the engine's real conflict path, the module finds exactly the backed-up files", () => {
  it("list → read → restore → dismiss over a genuine engine backup", async () => {
    // A bare remote with one seeded commit, and two clones that diverge on doc.md.
    const bare = join(root, "remote.git");
    git(["init", "--bare", "--initial-branch=main", bare], root);
    const seed = join(root, "seed");
    git(["clone", `file://${bare}`, seed], root);
    writeFileSync(join(seed, "doc.md"), "base\n");
    git(["add", "."], seed);
    git(["commit", "-m", "seed"], seed);
    git(["push", "origin", "HEAD:main"], seed);
    const clone = (name: string): string => {
      const dir = join(root, name);
      git(["clone", `file://${bare}`, dir], root);
      git(["checkout", "main"], dir);
      return dir;
    };

    const op1 = clone("op1");
    const op2 = clone("op2");
    writeFileSync(join(op1, "doc.md"), "op1 version\n");
    expect(await new SyncEngine({ now: Date.now, actor: "op" }).publish(op1)).toBe("ok");

    const precious = "op2 precious edit\n";
    writeFileSync(join(op2, "doc.md"), precious);
    const stamp = "1700000000000";
    expect(await new SyncEngine({ now: () => 1_700_000_000_000, actor: "op" }).publish(op2)).toBe("needs-help");

    const c = new Conflicts({ roots: [{ name: "team", dir: op2 }] });
    // Exactly the conflicted file was kept - nothing more, nothing less.
    expect(c.list()).toEqual([
      { root: "team", stamp, at: 1_700_000_000_000, files: [{ path: "doc.md", differs: true }] },
    ]);
    expect(c.read("team", stamp, "doc.md")).toEqual({ kept: precious, current: "op1 version\n" });

    // Copy back: the workspace file is the operator's version again, as an ordinary edit...
    expect(c.restore("team", stamp, "doc.md")).toEqual({ dir: op2 });
    expect(readFileSync(join(op2, "doc.md"), "utf8")).toBe(precious);
    // ...that the normal checkpoint path picks up like any other change.
    expect(await new SyncEngine({ now: Date.now, actor: "op" }).checkpoint(op2)).toBe("committed");
    expect(git(["log", "-1", "--pretty=%s"], op2)).toContain("doc.md");

    // Nothing left to bring back → dismiss clears the flag; the backup stays on disk.
    expect(c.list()[0]!.files).toEqual([{ path: "doc.md", differs: false }]);
    expect(c.dismiss("team", stamp)).toBe(true);
    expect(c.hasAttention()).toBe(false);
    expect(existsSync(join(op2, ".sync-needs-help"))).toBe(false);
    expect(readFileSync(join(op2, ".conflicts", stamp, "doc.md"), "utf8")).toBe(precious);
  });

  it("a second engine conflict keeps the first backup reachable (the marker accumulates)", async () => {
    const bare = join(root, "remote2.git");
    git(["init", "--bare", "--initial-branch=main", bare], root);
    const seed = join(root, "seed2");
    git(["clone", `file://${bare}`, seed], root);
    writeFileSync(join(seed, "doc.md"), "base\n");
    git(["add", "."], seed);
    git(["commit", "-m", "seed"], seed);
    git(["push", "origin", "HEAD:main"], seed);
    const clone = (name: string): string => {
      const dir = join(root, name);
      git(["clone", `file://${bare}`, dir], root);
      git(["checkout", "main"], dir);
      return dir;
    };
    const op1 = clone("2op1");
    const op2 = clone("2op2");

    // First divergence → first backup.
    writeFileSync(join(op1, "doc.md"), "op1 first\n");
    await new SyncEngine({ now: Date.now, actor: "op" }).publish(op1);
    writeFileSync(join(op2, "doc.md"), "op2 first\n");
    expect(await new SyncEngine({ now: () => 1000, actor: "op" }).publish(op2)).toBe("needs-help");

    // Second divergence before anyone looked → second backup, same marker file.
    writeFileSync(join(op1, "doc.md"), "op1 second\n");
    await new SyncEngine({ now: Date.now, actor: "op" }).publish(op1);
    writeFileSync(join(op2, "doc.md"), "op2 second\n");
    expect(await new SyncEngine({ now: () => 2000, actor: "op" }).publish(op2)).toBe("needs-help");

    const c = new Conflicts({ roots: [{ name: "team", dir: op2 }] });
    expect(c.list().map((b) => b.stamp)).toEqual(["2000", "1000"]);
    expect(c.read("team", "1000", "doc.md")!.kept).toBe("op2 first\n");
    expect(c.read("team", "2000", "doc.md")!.kept).toBe("op2 second\n");
  });
});
