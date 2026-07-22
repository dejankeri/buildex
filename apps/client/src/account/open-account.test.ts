import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { AccountStore } from "./account-store.js";
import { SyncEngine } from "../sync/engine.js";
import { openAccount, persistAndAttach } from "./open-account.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (a: string[], cwd: string) => execFileSync("git", a, { cwd, env: ENV, encoding: "utf8" });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "buildex-open-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bares(): { core: string; team: string; private: string } {
  const url = (name: string) => {
    const b = join(root, `${name}.git`);
    git(["init", "--bare", "--initial-branch=main", b], root);
    return `file://${b}`;
  };
  return { core: url("core"), team: url("team-acme"), private: url("private-o1") };
}
function localRoots(): { name: string; dir: string }[] {
  return ["core", "team", "private"].map((name) => {
    const dir = join(root, "org", "workspace", name);
    mkdirSync(dir, { recursive: true });
    git(["init", "--initial-branch=main", "."], dir);
    writeFileSync(join(dir, "doc.md"), `${name}\n`);
    git(["add", "-A"], dir); git(["commit", "-m", "seed"], dir);
    return { name, dir };
  });
}
const engine = () => new SyncEngine({ now: Date.now, actor: "t" });

describe("openAccount", () => {
  it("refuses a SANDBOX org before anything irreversible runs - provision is never called", async () => {
    // The whole point of the guard: on a sandbox org, the one-time setup token must NOT be burned and
    // NO credentials may land on the keychain. A fetch that is called at all fails the test - if the
    // guard moved after provision(), provision would invoke this fetch and this assertion would catch it.
    let fetchCalls = 0;
    const spyFetch = (async () => { fetchCalls++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const keychain = new InMemoryKeychain();
    const account = new AccountStore({ orgId: "demo", orgDir: join(root, "org"), keychain });

    await expect(
      openAccount(
        { fetch: spyFetch, account, engine: engine(), roots: localRoots(), sandbox: true, machineName: "laptop" },
        { baseUrl: "https://sync.test", setupToken: "xsetup_t" },
      ),
    ).rejects.toThrow(/sandbox/i);

    expect(fetchCalls).toBe(0); // provision (and its setup-token burn) never happened
    expect(keychain.get("org:demo:machine-token")).toBeUndefined(); // no credentials persisted
    expect(existsSync(join(root, "org", "account.json"))).toBe(false); // no account.json written
  });

  it("provisions, persists, then attaches for a real org, returning connected", async () => {
    const repos = bares();
    const roots = localRoots();
    const provisioned = {
      machineToken: "xmachine_" + "a".repeat(48),
      refreshToken: "xrefresh_" + "b".repeat(48),
      repos,
    };
    const order: string[] = [];
    const fakeFetch = (async (url: string) => {
      order.push("provision"); // /provision is the only network call openAccount makes directly
      expect(String(url)).toContain("/provision");
      return new Response(JSON.stringify(provisioned), { status: 200 });
    }) as unknown as typeof fetch;

    const keychain = new InMemoryKeychain();
    const account = new AccountStore({ orgId: "acme", orgDir: join(root, "org"), keychain });
    const origSave = account.save.bind(account);
    account.save = (baseUrl, result) => { order.push("save"); return origSave(baseUrl, result); };

    const res = await openAccount(
      { fetch: fakeFetch, account, engine: engine(), roots, sandbox: false, machineName: "laptop" },
      { baseUrl: "https://sync.test", setupToken: "xsetup_t" },
    );

    expect(res.state).toBe("connected");
    expect(order[0]).toBe("provision");
    expect(order[1]).toBe("save"); // persist BEFORE attach, so a crash mid-attach can be resumed
    expect(order.indexOf("provision")).toBeLessThan(order.indexOf("save"));
    // The account is persisted and the team commit reached its bare remote (attach's first publish).
    expect(existsSync(join(root, "org", "account.json"))).toBe(true);
    const teamRefs = git(["ls-remote", repos.team.replace("file://", "")], root);
    expect(teamRefs).toContain("refs/heads/main");
    // core (read-only) was never pushed.
    const coreRefs = git(["ls-remote", repos.core.replace("file://", "")], root);
    expect(coreRefs.includes("refs/heads/main")).toBe(false);
  });
});

describe("persistAndAttach", () => {
  it("saves account.json and first-publishes the team ref on a real file:// bare set - proving the extraction preserved openAccount's guarantees", async () => {
    const repos = bares();
    const roots = localRoots();
    const provisioned = {
      machineToken: "xmachine_" + "c".repeat(48),
      refreshToken: "xrefresh_" + "d".repeat(48),
      repos,
    };
    const keychain = new InMemoryKeychain();
    const account = new AccountStore({ orgId: "acme2", orgDir: join(root, "org"), keychain });

    const res = await persistAndAttach(
      { account, engine: engine(), roots, sandbox: false },
      "https://sync.test",
      provisioned,
    );

    expect(res.state).toBe("connected");
    expect(existsSync(join(root, "org", "account.json"))).toBe(true);
    const teamRefs = git(["ls-remote", repos.team.replace("file://", "")], root);
    expect(teamRefs).toContain("refs/heads/main");
    const coreRefs = git(["ls-remote", repos.core.replace("file://", "")], root);
    expect(coreRefs.includes("refs/heads/main")).toBe(false);
  });
});
