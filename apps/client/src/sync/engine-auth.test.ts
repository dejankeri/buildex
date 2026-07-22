// apps/client/src/sync/engine-auth.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SyncEngine, type EngineAuth } from "./engine.js";
import { gitAuthEnv } from "../account/credentials.js";

// A fake remote that captures the Authorization http.extraHeader by using a local helper `git`
// wrapper is heavy; instead assert at the env layer: drive publish against a file:// bare remote
// (which needs no auth) and confirm the header env is present on the spawned git, and that an
// auth-classified failure triggers exactly one rotate + retry.

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "buildex-eauth-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function clonedWithRemote(): string {
  const bare = join(root, "r.git");
  git(["init", "--bare", "--initial-branch=main", bare], root);
  const seed = join(root, "seed");
  git(["clone", `file://${bare}`, seed], root);
  writeFileSync(join(seed, "a.md"), "x\n");
  git(["add", "."], seed); git(["commit", "-m", "seed"], seed); git(["push", "origin", "HEAD:main"], seed);
  const dir = join(root, "work");
  git(["clone", `file://${bare}`, dir], root);
  return dir;
}

describe("SyncEngine auth", () => {
  it("retries a push exactly once after an auth failure, then succeeds", async () => {
    const dir = clonedWithRemote();
    writeFileSync(join(dir, "b.md"), "y\n");
    let rotations = 0;
    let firstTry = true;
    // First git call is forced to actually fail (a malformed GIT_CONFIG_KEY_0 makes git itself error
    // out on any subcommand, deterministically, without depending on a live 401) so the classifyAuthError
    // test seam can drive the retry path; onAuthError flips the gate so the retry runs with a real header.
    // (A bare GIT_CONFIG_COUNT override alone does not reliably fail here: some sandboxes pre-seed
    // GIT_CONFIG_KEY_0/VALUE_0 in process.env for credential prompting, which the merge would inherit.)
    const auth: EngineAuth = {
      headerEnv: () => (firstTry ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "not-a-valid-key" } : gitAuthEnv("xmachine_ok")),
      onAuthError: async () => { rotations++; firstTry = false; return true; },
    };
    const engine = new SyncEngine({ now: Date.now, actor: "t", auth, classifyAuthError: () => firstTry });
    const r = await engine.publish(dir);
    expect(rotations).toBe(1);      // rotated once...
    expect(r).toBe("ok");           // ...and the retry succeeded
  });

  it("does not rotate when the failure is not an auth failure", async () => {
    const dir = clonedWithRemote();
    let rotations = 0;
    const auth: EngineAuth = { headerEnv: () => undefined, onAuthError: async () => { rotations++; return true; } };
    // A clean publish (no failure) must never call onAuthError.
    writeFileSync(join(dir, "c.md"), "z\n");
    const engine = new SyncEngine({ now: Date.now, actor: "t", auth });
    await engine.publish(dir);
    expect(rotations).toBe(0);
  });
});
