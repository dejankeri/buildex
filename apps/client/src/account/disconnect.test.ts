// disconnect() is the local-disconnect orchestration behind "Log out": revert an attached org to a
// clean, unconnected local state while KEEPING every root's git history (invariant 8, "never lose an
// operator's work" - this reverts the connection, never the work). Mirrors open-account.test.ts's
// real file:// bare + temp-root setup so the roots here are genuinely attached, not mocked.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { AccountStore } from "./account-store.js";
import { SyncEngine } from "../sync/engine.js";
import { disconnect } from "./disconnect.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (a: string[], cwd: string) => execFileSync("git", a, { cwd, env: ENV, encoding: "utf8" });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "buildex-disconnect-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bares(): { core: string; team: string; private: string } {
  const url = (name: string) => {
    const b = join(root, `${name}.git`);
    git(["init", "--bare", "--initial-branch=main", b], root);
    return `file://${b}`;
  };
  return { core: url("core"), team: url("team-acme"), private: url("private-o1") };
}
/** Local roots, each with a seed commit AND an `origin` remote already attached - the state a real
 *  connected org is in before the operator logs out. */
function attachedRoots(repos: { core: string; team: string; private: string }): { name: string; dir: string }[] {
  return (["core", "team", "private"] as const).map((name) => {
    const dir = join(root, "org", "workspace", name);
    mkdirSync(dir, { recursive: true });
    git(["init", "--initial-branch=main", "."], dir);
    writeFileSync(join(dir, "doc.md"), `${name}\n`);
    git(["add", "-A"], dir);
    git(["commit", "-m", "seed"], dir);
    git(["remote", "add", "origin", repos[name]], dir);
    return { name, dir };
  });
}
const engine = () => new SyncEngine({ now: Date.now, actor: "t" });

describe("disconnect", () => {
  it("reverts every root to unconnected local state while keeping each root's git history", async () => {
    const repos = bares();
    const roots = attachedRoots(repos);
    const keychain = new InMemoryKeychain();
    const account = new AccountStore({ orgId: "acme", orgDir: join(root, "org"), keychain });
    account.save("https://sync.test", {
      machineToken: "xmachine_" + "a".repeat(48),
      refreshToken: "xrefresh_" + "b".repeat(48),
      repos,
    });

    // Sanity: genuinely attached + connected before disconnecting.
    for (const r of roots) expect(await engine().hasRemote(r.dir)).toBe(true);
    expect(account.connected()).toBe(true);
    expect(keychain.get("org:acme:machine-token")).toBeDefined();

    const res = await disconnect({ engine: engine(), account, roots });

    expect(res).toEqual({ state: "local" });

    for (const r of roots) {
      expect(await engine().hasRemote(r.dir)).toBe(false); // no remote left
      expect(git(["log", "--pretty=%s"], r.dir)).toContain("seed"); // work kept (invariant 8)
    }
    expect(existsSync(join(root, "org", "account.json"))).toBe(false);
    expect(account.load()).toBeNull();
    expect(account.connected()).toBe(false);
    expect(keychain.get("org:acme:machine-token")).toBeUndefined();
    expect(keychain.get("org:acme:refresh-token")).toBeUndefined();
  });
});
