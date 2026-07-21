import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { unsavedIn, unsavedAcross, isStale, STALE_AFTER_MS } from "./unsaved.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
} as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let root: string;
let remote: string;

function seedRemote(): string {
  const bare = join(root, "remote.git");
  git(["init", "--bare", "--initial-branch=main", bare], root);
  const seed = join(root, "seed");
  git(["clone", `file://${bare}`, seed], root);
  writeFileSync(join(seed, "doc.md"), "base\n");
  git(["add", "."], seed);
  git(["commit", "-m", "seed"], seed);
  git(["push", "origin", "HEAD:main"], seed);
  return bare;
}
function clone(name: string): string {
  const dir = join(root, name);
  git(["clone", `file://${remote}`, dir], root);
  git(["checkout", "main"], dir);
  return dir;
}
function commitFile(dir: string, rel: string, body: string): void {
  writeFileSync(join(dir, rel), body);
  git(["add", "-A"], dir);
  git(["commit", "-m", `edit ${rel}`], dir);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "buildex-unsaved-"));
  remote = seedRemote();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("unsavedIn", () => {
  it("reports nothing when level with the remote", async () => {
    const dir = clone("a");
    expect(await unsavedIn(dir)).toEqual({ files: 0, oldestAt: null });
  });

  it("counts a committed-but-unsent change and dates it", async () => {
    const dir = clone("a");
    commitFile(dir, "doc.md", "changed\n");
    const u = await unsavedIn(dir);
    expect(u.files).toBe(1);
    expect(u.oldestAt).toBeGreaterThan(0);
  });

  it("counts FILES, not revisions - the operator thinks in documents", async () => {
    const dir = clone("a");
    commitFile(dir, "doc.md", "one\n");
    commitFile(dir, "doc.md", "two\n");
    commitFile(dir, "doc.md", "three\n");
    expect((await unsavedIn(dir)).files).toBe(1);
  });

  it("dates the work from the OLDEST unsent checkpoint, which is what the nudge escalates on", async () => {
    const dir = clone("a");
    commitFile(dir, "one.md", "1\n");
    const first = (await unsavedIn(dir)).oldestAt;
    commitFile(dir, "two.md", "2\n");
    expect((await unsavedIn(dir)).oldestAt).toBe(first);
  });

  it("counts an edit that has not been checkpointed yet - it is genuinely unsaved", async () => {
    const dir = clone("a");
    writeFileSync(join(dir, "fresh.md"), "typed a second ago\n");
    expect((await unsavedIn(dir)).files).toBe(1);
  });

  it("does not double-count a file that is both committed and edited again", async () => {
    const dir = clone("a");
    commitFile(dir, "doc.md", "committed\n");
    writeFileSync(join(dir, "doc.md"), "and edited again\n");
    expect((await unsavedIn(dir)).files).toBe(1);
  });

  it("never counts workspace-internal paths", async () => {
    const dir = clone("a");
    mkdirSync(join(dir, ".conflicts", "123"), { recursive: true });
    writeFileSync(join(dir, ".conflicts", "123", "doc.md"), "backup\n");
    writeFileSync(join(dir, ".sync-needs-help"), "flagged\n");
    mkdirSync(join(dir, ".sessions"), { recursive: true });
    writeFileSync(join(dir, ".sessions", "s1.json"), "{}\n");
    expect(await unsavedIn(dir)).toEqual({ files: 0, oldestAt: null });
  });

  it("treats everything as unsaved when there is no account yet", async () => {
    const dir = join(root, "localonly");
    mkdirSync(dir, { recursive: true });
    git(["init", "--initial-branch=main", "."], dir);
    writeFileSync(join(dir, "a.md"), "a\n");
    writeFileSync(join(dir, "b.md"), "b\n");
    git(["add", "-A"], dir);
    git(["commit", "-m", "local"], dir);
    const u = await unsavedIn(dir);
    expect(u.files).toBe(2);
    expect(u.oldestAt).toBeGreaterThan(0);
  });

  it("reports nothing for a repository with no commits at all", async () => {
    const dir = join(root, "empty");
    mkdirSync(dir, { recursive: true });
    git(["init", "--initial-branch=main", "."], dir);
    expect(await unsavedIn(dir)).toEqual({ files: 0, oldestAt: null });
  });
});

describe("isStale", () => {
  const t = 1_700_000_000_000;

  it("is not stale with nothing waiting", () => {
    expect(isStale(null, t)).toBe(false);
  });

  it("is not stale just under a day", () => {
    expect(isStale(t - (STALE_AFTER_MS - 1), t)).toBe(false);
  });

  it("is stale just over a day", () => {
    expect(isStale(t - (STALE_AFTER_MS + 1), t)).toBe(true);
  });

  it("is not stale exactly on the threshold - the nudge fires after a day, not at it", () => {
    expect(isStale(t - STALE_AFTER_MS, t)).toBe(false);
  });

  it("is not stale for a future timestamp, so a clock skew never invents urgency", () => {
    expect(isStale(t + 60_000, t)).toBe(false);
  });
});

describe("unsavedAcross", () => {
  it("sums the files and keeps the earliest date", async () => {
    const a = clone("a");
    const b = clone("b");
    commitFile(a, "one.md", "1\n");
    const aOldest = (await unsavedIn(a)).oldestAt!;
    commitFile(b, "two.md", "2\n");
    commitFile(b, "three.md", "3\n");
    const u = await unsavedAcross([a, b]);
    expect(u.files).toBe(3);
    expect(u.oldestAt).toBe(aOldest);
  });

  it("reports nothing across clean roots", async () => {
    expect(await unsavedAcross([clone("a"), clone("b")])).toEqual({ files: 0, oldestAt: null });
  });

  it("ignores a root that is not a repository rather than failing the whole count", async () => {
    const a = clone("a");
    commitFile(a, "one.md", "1\n");
    const notARepo = join(root, "plain");
    mkdirSync(notARepo, { recursive: true });
    expect((await unsavedAcross([a, notARepo])).files).toBe(1);
  });
});
