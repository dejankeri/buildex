import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileHistory, recentChanges, fileAtCommit } from "./history.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Dana", GIT_AUTHOR_EMAIL: "dana@x", GIT_COMMITTER_NAME: "Dana", GIT_COMMITTER_EMAIL: "dana@x" } as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-hist-"));
  git(["init", "--initial-branch=main", dir], dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("fileHistory", () => {
  it("returns commits touching a file, newest first, with sha/subject/author", () => {
    writeFileSync(join(dir, "doc.md"), "one\n");
    git(["add", "."], dir);
    git(["commit", "-m", "add doc"], dir);
    writeFileSync(join(dir, "doc.md"), "two\n");
    git(["add", "."], dir);
    git(["commit", "-m", "revise doc"], dir);

    const hist = fileHistory(dir, "doc.md");
    expect(hist.map((h) => h.subject)).toEqual(["revise doc", "add doc"]);
    expect(hist[0]!.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(hist[0]!.author).toBe("Dana");
    expect(typeof hist[0]!.at).toBe("number");
  });

  it("returns an empty history for an unknown file", () => {
    expect(fileHistory(dir, "nope.md")).toEqual([]);
  });

  it("fileAtCommit reads a file's exact content at an earlier commit (powers one-tap restore)", () => {
    writeFileSync(join(dir, "doc.md"), "version one\n");
    git(["add", "."], dir);
    git(["commit", "-m", "v1"], dir);
    writeFileSync(join(dir, "doc.md"), "version two\n");
    git(["add", "."], dir);
    git(["commit", "-m", "v2"], dir);

    const [head, prev] = fileHistory(dir, "doc.md"); // newest first: v2, v1
    expect(fileAtCommit(dir, "doc.md", head!.sha)).toBe("version two\n");
    expect(fileAtCommit(dir, "doc.md", prev!.sha)).toBe("version one\n"); // the restore source
  });

  it("fileAtCommit rejects a malformed sha (guards the git arg)", () => {
    expect(() => fileAtCommit(dir, "doc.md", "not-a-sha")).toThrow(/invalid commit id/);
    expect(() => fileAtCommit(dir, "doc.md", "../../etc")).toThrow(/invalid commit id/);
  });

  it("is deterministic (same repo state → identical history)", () => {
    writeFileSync(join(dir, "a.md"), "x\n");
    git(["add", "."], dir);
    git(["commit", "-m", "a"], dir);
    expect(JSON.stringify(fileHistory(dir, "a.md"))).toBe(JSON.stringify(fileHistory(dir, "a.md")));
  });
});

describe("recentChanges", () => {
  it("returns repo-wide commits newest first, with the files each touched", () => {
    writeFileSync(join(dir, "a.md"), "one\n");
    git(["add", "."], dir);
    git(["commit", "-m", "first decision"], dir);
    writeFileSync(join(dir, "b.md"), "two\n");
    writeFileSync(join(dir, "a.md"), "one-and-a-half\n");
    git(["add", "."], dir);
    git(["commit", "-m", "second decision"], dir);

    const ch = recentChanges(dir, 10);
    expect(ch.map((c) => c.subject)).toEqual(["second decision", "first decision"]);
    expect(ch[0]!.files.sort()).toEqual(["a.md", "b.md"]);
    expect(ch[1]!.files).toEqual(["a.md"]);
    expect(ch[0]!.author).toBe("Dana");
    expect(ch[0]!.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(typeof ch[0]!.at).toBe("number");
  });

  it("honors the limit (most recent N commits)", () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `f${i}.md`), `${i}\n`);
      git(["add", "."], dir);
      git(["commit", "-m", `commit ${i}`], dir);
    }
    const ch = recentChanges(dir, 2);
    expect(ch.map((c) => c.subject)).toEqual(["commit 4", "commit 3"]);
  });

  it("returns an empty list for a repo with no commits", () => {
    expect(recentChanges(dir, 10)).toEqual([]);
  });

  it("survives subjects containing separators and unicode", () => {
    writeFileSync(join(dir, "weird.md"), "z\n");
    git(["add", "."], dir);
    git(["commit", "-m", "chose net-30 · supersedes prior terms - final"], dir);
    const ch = recentChanges(dir, 5);
    expect(ch[0]!.subject).toBe("chose net-30 · supersedes prior terms - final");
    expect(ch[0]!.files).toEqual(["weird.md"]);
  });
});

// The two-layer model (invariant 2): checkpoints (marked subjects) are the automatic layer and
// collapse; saves are the named layer History shows.
describe("checkpoint collapsing - History shows saves", () => {
  const checkpoint = (rel: string, body: string) => {
    writeFileSync(join(dir, rel), body);
    git(["add", "."], dir);
    git(["commit", "-m", `~op: update ${rel}`], dir);
  };
  const save = (rel: string, body: string, subject: string) => {
    writeFileSync(join(dir, rel), body);
    git(["add", "."], dir);
    git(["commit", "-m", subject], dir);
  };

  it("fileHistory collapses the checkpoints newer than the last save into one 'Unsaved changes' row", () => {
    save("doc.md", "v1\n", "First save");
    checkpoint("doc.md", "v2\n");
    checkpoint("doc.md", "v3\n");
    const hist = fileHistory(dir, "doc.md");
    expect(hist.map((h) => h.subject)).toEqual(["Unsaved changes", "First save"]);
    // The synthetic row anchors on the NEWEST checkpoint - viewing it shows the current content.
    expect(fileAtCommit(dir, "doc.md", hist[0]!.sha)).toBe("v3\n");
  });

  it("fileHistory shows no synthetic row when a save is the tip", () => {
    checkpoint("doc.md", "v1\n");
    save("doc.md", "v2\n", "Named it");
    expect(fileHistory(dir, "doc.md").map((h) => h.subject)).toEqual(["Named it"]);
  });

  it("fileHistory omits the synthetic row for a file the waiting checkpoints never touched", () => {
    save("doc.md", "v1\n", "First save");
    checkpoint("other.md", "x\n"); // the file-scoped log for doc.md never sees this
    expect(fileHistory(dir, "doc.md").map((h) => h.subject)).toEqual(["First save"]);
  });

  it("recentChanges collapses leading checkpoints into one row carrying the union of their files", () => {
    save("doc.md", "v1\n", "First save");
    checkpoint("a.md", "a\n");
    checkpoint("b.md", "b\n");
    const ch = recentChanges(dir, 12);
    expect(ch.map((c) => c.subject)).toEqual(["Unsaved changes", "First save"]);
    expect(ch[0]!.files.sort()).toEqual(["a.md", "b.md"]);
  });

  it("drops checkpoint commits older than a save instead of showing them twice", () => {
    checkpoint("doc.md", "v1\n"); // pre-save history (e.g. the root of a just-attached workspace)
    save("doc.md", "v2\n", "Named it");
    checkpoint("doc.md", "v3\n");
    expect(recentChanges(dir, 12).map((c) => c.subject)).toEqual(["Unsaved changes", "Named it"]);
    expect(fileHistory(dir, "doc.md").map((h) => h.subject)).toEqual(["Unsaved changes", "Named it"]);
  });

  it("stays deterministic: double-rendering the same repo state is byte-identical", () => {
    save("doc.md", "v1\n", "First save");
    checkpoint("doc.md", "v2\n");
    expect(JSON.stringify(fileHistory(dir, "doc.md"))).toBe(JSON.stringify(fileHistory(dir, "doc.md")));
    expect(JSON.stringify(recentChanges(dir, 12))).toBe(JSON.stringify(recentChanges(dir, 12)));
  });
});
