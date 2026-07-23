import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { AccountStore } from "./account-store.js";
import { SyncEngine } from "../sync/engine.js";
import { signUpAnonymous } from "./anonymous.js";
import type { SupabaseAuthClient } from "./sign-in.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (a: string[], cwd: string) => execFileSync("git", a, { cwd, env: ENV, encoding: "utf8" });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "buildex-anon-")); });
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

function fakeSupabase(jwt: string, onCall?: () => void): SupabaseAuthClient {
  return {
    authorizeUrl: () => { throw new Error("not used by the anonymous flow"); },
    exchangeCode: async () => { throw new Error("not used by the anonymous flow"); },
    signInAnonymously: async () => { onCall?.(); return { jwt }; },
  };
}

describe("signUpAnonymous", () => {
  it("refuses a SANDBOX org before anything irreversible - signInAnonymously is NEVER called", async () => {
    // The guard must run before the anon Supabase sign-in itself, not just before persistAndAttach's
    // own (redundant) guard: for this path the anon user IS the credential, so a sandbox org must
    // never even create one - a fetch or a signInAnonymously call at all fails the test.
    let anonCalls = 0;
    const supabase = fakeSupabase("anon.jwt", () => { anonCalls++; });
    let fetchCalls = 0;
    const spyFetch = (async () => { fetchCalls++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const keychain = new InMemoryKeychain();
    const account = new AccountStore({ orgId: "demo", orgDir: join(root, "org"), keychain });

    await expect(
      signUpAnonymous(
        {
          supabase,
          account,
          engine: engine(),
          roots: localRoots(),
          sandbox: true,
          fetch: spyFetch,
          baseUrl: "https://sync.test",
          machineName: "laptop",
        },
        { companyName: "Acme Corp" },
      ),
    ).rejects.toThrow(/sandbox/i);

    expect(anonCalls).toBe(0); // guard fires before signInAnonymously - no zombie anon user
    expect(fetchCalls).toBe(0); // and certainly before /session is ever reached
    expect(keychain.get("org:demo:machine-token")).toBeUndefined(); // no credentials persisted
    expect(existsSync(join(root, "org", "account.json"))).toBe(false); // no account.json written
  });

  it("signs in anonymously, posts /session with the company name, persists, and attaches - connected", async () => {
    const repos = bares();
    const roots = localRoots();
    const provisioned = {
      machineToken: "xmachine_" + "a".repeat(48),
      refreshToken: "xrefresh_" + "b".repeat(48),
      repos,
    };
    let seenUrl = "";
    let seenBody = "";
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init.body);
      return new Response(JSON.stringify(provisioned), { status: 200 });
    }) as unknown as typeof fetch;

    const keychain = new InMemoryKeychain();
    const account = new AccountStore({ orgId: "acme", orgDir: join(root, "org"), keychain });

    const res = await signUpAnonymous(
      {
        supabase: fakeSupabase("anon.jwt"),
        account,
        engine: engine(),
        roots,
        sandbox: false,
        fetch: fakeFetch,
        baseUrl: "https://sync.test",
        machineName: "laptop",
      },
      { companyName: "Acme Corp" },
    );

    expect(res.state).toBe("connected");
    expect(seenUrl).toBe("https://sync.test/session");
    expect(JSON.parse(seenBody)).toEqual({ jwt: "anon.jwt", companyName: "Acme Corp", machineName: "laptop" });

    // The account is persisted and the team commit reached its bare remote (attach's first publish).
    expect(existsSync(join(root, "org", "account.json"))).toBe(true);
    const teamRefs = git(["ls-remote", repos.team.replace("file://", "")], root);
    expect(teamRefs).toContain("refs/heads/main");
    // core (read-only) was never pushed.
    const coreRefs = git(["ls-remote", repos.core.replace("file://", "")], root);
    expect(coreRefs.includes("refs/heads/main")).toBe(false);
  });

  it("maps a needs-help attach result (a real rebase conflict) through to state:needs-help", async () => {
    const repos = bares();
    const teamPath = repos.team.replace("file://", "");

    // Seed the team remote with a common-ancestor commit, then have the local root and a second
    // "other machine" diverge from that SAME base on the same file - the real conflict recipe used
    // by sync/engine.test.ts, so the collision (and thus needs-help) is real git, not a mock.
    const seed = join(root, "seed-team");
    git(["clone", teamPath, seed], root);
    writeFileSync(join(seed, "doc.md"), "base\n");
    git(["add", "-A"], seed);
    git(["commit", "-m", "base"], seed);
    git(["push", "origin", "HEAD:main"], seed);

    const teamDir = join(root, "org", "workspace", "team");
    mkdirSync(join(root, "org", "workspace"), { recursive: true });
    git(["clone", teamPath, teamDir], root); // local root starts at "base", same as the remote
    writeFileSync(join(teamDir, "doc.md"), "local precious edit\n");
    git(["add", "-A"], teamDir);
    git(["commit", "-m", "local change"], teamDir); // diverges locally, NOT pushed yet

    const otherMachine = join(root, "other-machine-team");
    git(["clone", teamPath, otherMachine], root); // also starts at "base"
    writeFileSync(join(otherMachine, "doc.md"), "someone else's edit\n");
    git(["add", "-A"], otherMachine);
    git(["commit", "-m", "remote change"], otherMachine);
    git(["push", "origin", "HEAD:main"], otherMachine); // origin/main now diverges from local team's base too

    const coreDir = join(root, "org", "workspace", "core");
    mkdirSync(coreDir, { recursive: true });
    git(["init", "--initial-branch=main", "."], coreDir);
    writeFileSync(join(coreDir, "doc.md"), "core\n");
    git(["add", "-A"], coreDir);
    git(["commit", "-m", "seed"], coreDir);

    const privateDir = join(root, "org", "workspace", "private");
    mkdirSync(privateDir, { recursive: true });
    git(["init", "--initial-branch=main", "."], privateDir);
    writeFileSync(join(privateDir, "doc.md"), "private\n");
    git(["add", "-A"], privateDir);
    git(["commit", "-m", "seed"], privateDir);

    const roots = [
      { name: "core", dir: coreDir },
      { name: "team", dir: teamDir },
      { name: "private", dir: privateDir },
    ];

    const provisioned = {
      machineToken: "xmachine_" + "c".repeat(48),
      refreshToken: "xrefresh_" + "d".repeat(48),
      repos,
    };
    const fakeFetch = (async () => new Response(JSON.stringify(provisioned), { status: 200 })) as unknown as typeof fetch;
    const keychain = new InMemoryKeychain();
    const account = new AccountStore({ orgId: "acme3", orgDir: join(root, "org"), keychain });

    const res = await signUpAnonymous(
      {
        supabase: fakeSupabase("anon.jwt"),
        account,
        engine: engine(),
        roots,
        sandbox: false,
        fetch: fakeFetch,
        baseUrl: "https://sync.test",
        machineName: "laptop",
      },
      { companyName: "Acme Corp" },
    );

    expect(res.state).toBe("needs-help");
    // Even on a conflict, persistAndAttach already saved the account before attaching.
    expect(existsSync(join(root, "org", "account.json"))).toBe(true);
  });
});
