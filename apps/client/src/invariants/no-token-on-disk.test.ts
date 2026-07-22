// [release-gate:no-token-on-disk] After a complete account-open + sync, the machine token exists ONLY
// in the injected keychain - never in a working tree, a .git/config, a remote URL, or account.json.
// This is the invariant the GIT_CONFIG_* http.extraHeader approach exists to protect; a regression to
// a credential helper or a URL-embedded token must fail the build. It runs in the apps/client suite
// (not the cross-module smoke) so it executes on Windows, where the keychain/path/git differ most.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { AccountStore } from "../account/account-store.js";
import { attachOrg } from "../account/attach.js";
import { gitAuthEnv } from "../account/credentials.js";
import { SyncEngine } from "../sync/engine.js";

const TOKEN = "xmachine_" + "feedface".repeat(6);
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (a: string[], cwd: string) => execFileSync("git", a, { cwd, env: ENV, encoding: "utf8" });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "buildex-notok-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("INVARIANT [release-gate:no-token-on-disk]: an opened account keeps its token off disk", () => {
  it("no file under the org - working tree, .git/config, or account.json - contains the machine token", async () => {
    // Bare remotes named as the server would name them.
    const bares: Record<string, string> = {};
    for (const name of ["core", "team-acme", "private-o1"]) {
      const b = join(root, `${name}.git`);
      git(["init", "--bare", "--initial-branch=main", b], root);
      bares[name] = `file://${b}`;
    }
    // Local org roots with real content.
    const orgDir = join(root, "org");
    const roots = ["core", "team", "private"].map((name) => {
      const dir = join(orgDir, "workspace", name);
      mkdirSync(dir, { recursive: true });
      git(["init", "--initial-branch=main", "."], dir);
      writeFileSync(join(dir, "doc.md"), `${name} content\n`);
      git(["add", "-A"], dir); git(["commit", "-m", "seed"], dir);
      return { name, dir };
    });

    const repos = { core: bares.core!, team: bares["team-acme"]!, private: bares["private-o1"]! };
    const keychain = new InMemoryKeychain();
    const store = new AccountStore({ orgId: "o1", orgDir, keychain });
    store.save("https://sync.test", { machineToken: TOKEN, refreshToken: "xrefresh_" + "1".repeat(48), repos });

    const engine = new SyncEngine({
      now: Date.now, actor: "t",
      auth: { headerEnv: () => gitAuthEnv(store.tokens()!.machineToken), onAuthError: async () => false },
    });
    const res = await attachOrg({ engine, roots, repos, sandbox: false });
    expect(res.status).toBe("connected");

    // The token is present in the keychain...
    expect(keychain.get("org:o1:machine-token")).toBe(TOKEN);
    // ...and NOWHERE on disk under the org dir (working trees, every .git/config, account.json).
    for (const file of walk(orgDir)) {
      const bytes = readFileSync(file);
      expect(bytes.includes(Buffer.from(TOKEN)), `token leaked into ${file}`).toBe(false);
    }
  });
});
