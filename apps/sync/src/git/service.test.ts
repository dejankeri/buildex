import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { EmbeddedGitService } from "./service.js";

// NOTE ON TRANSPORT: these unit tests prove the two halves socket-free (fast, sandbox-safe):
// (a) the bare repo is a genuine push/clone target via git's fs-only `file://` transport;
// (b) `cgi()` runs the real `git http-backend` in-process and returns correct protocol bytes
// reflecting real repo state. The full HTTP-socket clone/push e2e - a real `git` child process over
// a real TCP socket through the Node adapter - lives in `http/git-socket.test.ts`, which runs
// wherever inter-process loopback TCP is available (CI, dev machines) and self-skips where it isn't.

let root: string;
let work: string;
let git: EmbeddedGitService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "buildex-repos-"));
  work = mkdtempSync(join(tmpdir(), "buildex-work-"));
  git = new EmbeddedGitService({ reposRoot: root });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
} as NodeJS.ProcessEnv;
const g = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

describe("ensureRepo", () => {
  it("creates a bare repo", async () => {
    await git.ensureRepo("team-acme");
    const bare = execFileSync("git", ["rev-parse", "--is-bare-repository"], {
      cwd: git.repoDir("team-acme"), encoding: "utf8",
    }).trim();
    expect(bare).toBe("true");
  });

  it("is idempotent", async () => {
    await git.ensureRepo("team-acme");
    await expect(git.ensureRepo("team-acme")).resolves.toBeUndefined();
  });

  it("rejects unsafe repo names (path traversal)", async () => {
    await expect(git.ensureRepo("../escape")).rejects.toThrow();
    await expect(
      git.cgi({ repo: "..", pathAfterRepo: "/info/refs", method: "GET", query: "", body: Buffer.alloc(0) }),
    ).rejects.toThrow();
  });
});

describe("the bare repo is a real push/clone target (git file:// - fs only)", () => {
  it("clone → commit → push → re-clone round-trips content", async () => {
    await git.ensureRepo("team-acme");
    const url = `file://${git.repoDir("team-acme")}`;
    const a = join(work, "a");
    g(["clone", url, a], work);
    writeFileSync(join(a, "hello.md"), "# hello buildex\n");
    g(["add", "."], a);
    g(["commit", "-m", "first"], a);
    g(["push", "origin", "HEAD:main"], a);

    const b = join(work, "b");
    g(["clone", "--branch", "main", url, b], work);
    expect(execFileSync("cat", [join(b, "hello.md")], { encoding: "utf8" })).toContain("hello buildex");
  });
});

describe("cgi() smart-HTTP bridge (in-process git http-backend)", () => {
  it("advertises the upload-pack service with the correct content-type", async () => {
    await git.ensureRepo("core");
    const res = await git.cgi({
      repo: "core", pathAfterRepo: "/info/refs", method: "GET",
      query: "service=git-upload-pack", body: Buffer.alloc(0),
    });
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/x-git-upload-pack-advertisement");
    expect(res.body.toString("utf8")).toContain("# service=git-upload-pack");
  });

  it("advertises receive-pack (ensureRepo enabled http.receivepack)", async () => {
    await git.ensureRepo("team-acme");
    const res = await git.cgi({
      repo: "team-acme", pathAfterRepo: "/info/refs", method: "GET",
      query: "service=git-receive-pack", body: Buffer.alloc(0),
    });
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toContain("# service=git-receive-pack");
  });

  it("reflects real repo state: a pushed ref appears in the advertisement", async () => {
    await git.ensureRepo("team-acme");
    const url = `file://${git.repoDir("team-acme")}`;
    const a = join(work, "a");
    g(["clone", url, a], work);
    writeFileSync(join(a, "x.md"), "x\n");
    g(["add", "."], a);
    g(["commit", "-m", "c"], a);
    g(["push", "origin", "HEAD:main"], a);

    const res = await git.cgi({
      repo: "team-acme", pathAfterRepo: "/info/refs", method: "GET",
      query: "service=git-upload-pack", body: Buffer.alloc(0),
    });
    expect(res.body.toString("utf8")).toContain("refs/heads/main");
  });
});
