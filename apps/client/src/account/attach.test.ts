// apps/client/src/account/attach.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SyncEngine } from "../sync/engine.js";
import { attachOrg } from "./attach.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "buildex-attach-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bare(name: string): string {
  const b = join(root, `${name}.git`);
  git(["init", "--bare", "--initial-branch=main", b], root);
  return `file://${b}`;
}
function localRoot(name: string, seedFile: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(["init", "--initial-branch=main", "."], dir);
  writeFileSync(join(dir, seedFile), "local\n");
  git(["add", "-A"], dir); git(["commit", "-m", "local"], dir);
  return dir;
}
const engine = () => new SyncEngine({ now: Date.now, actor: "t" });
function repos() { return { core: bare("core"), team: bare("team-acme"), private: bare("private-o1") }; }

describe("attachOrg", () => {
  it("attaches writable roots to an empty upstream and pushes local history up (first operator)", async () => {
    const roots = [
      { name: "core", dir: localRoot("core", "c.md") },
      { name: "team", dir: localRoot("team", "t.md") },
      { name: "private", dir: localRoot("private", "p.md") },
    ];
    const r = repos();
    const res = await attachOrg({ engine: engine(), roots, repos: r, sandbox: false });
    expect(res.status).toBe("connected");
    // team's local commit reached the bare remote; core (read-only) did NOT get pushed.
    const teamRefs = git(["ls-remote", r.team.replace("file://", "")], root);
    expect(teamRefs).toContain("refs/heads/main");
    const coreRefs = git(["ls-remote", r.core.replace("file://", "")], root);
    expect(coreRefs.includes("refs/heads/main")).toBe(false); // core is pull-only; attach never pushes it
  });

  it("is idempotent - re-running attaches once more without error and re-points origin", async () => {
    const roots = [
      { name: "core", dir: localRoot("core", "c.md") },
      { name: "team", dir: localRoot("team", "t.md") },
      { name: "private", dir: localRoot("private", "p.md") },
    ];
    const r = repos();
    await attachOrg({ engine: engine(), roots, repos: r, sandbox: false });
    const res = await attachOrg({ engine: engine(), roots, repos: r, sandbox: false }); // again
    expect(res.status).toBe("connected");
    expect(git(["remote", "get-url", "origin"], roots[1]!.dir).trim()).toBe(r.team);
  });

  it("refuses to attach a sandbox org", async () => {
    const roots = [{ name: "team", dir: localRoot("team", "t.md") }];
    await expect(attachOrg({ engine: engine(), roots, repos: repos(), sandbox: true })).rejects.toThrow(/sandbox/i);
  });
});
