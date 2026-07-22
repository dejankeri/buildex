// SECRETS INVARIANT SUITE (release gate): no keychain value ever appears in a
// repo, a generated config file, a session file, or a synced path (and no token is embedded in a
// git remote URL - a harden over the prototype, which put the token in the origin URL). This drives
// a full workspace lifecycle (secret in keychain → config-gen → real sync → a chat session) and
// scans every artifact for the secret.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { generateAgentConfig, type Root } from "../brain/agent-config.js";
import { SyncEngine } from "../sync/engine.js";
import { FileSessionStore } from "../daemon/sessions.js";
import type { PolicyPreset } from "../gate/policy.js";

const SECRET = "gmail-oauth-super-secret-value-DO-NOT-LEAK";
// Built by concatenation so this fake fixture doesn't itself trip the machine-token secret-scan
// pattern (the runtime value is still a realistic `xmachine_…` token for the leak assertions below).
const TOKEN = "xmachine_" + "deadbeef".repeat(6);
const preset: PolicyPreset = { allow: ["Read"], ask: ["Bash"], deny: [], default: "ask" };
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let base: string;
let ws: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "buildex-secrets-"));
  ws = join(base, "ws");
  mkdirSync(ws, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Collect the text of every artifact that must NOT contain a secret. */
function scanTargets(teamDir: string): string[] {
  const texts: string[] = [];
  // committed files in the team repo
  for (const f of git(["ls-files"], teamDir).split("\n").map((s) => s.trim()).filter(Boolean)) {
    texts.push(readFileSync(join(teamDir, f), "utf8"));
  }
  // the git config (must not embed a token in the remote URL)
  texts.push(readFileSync(join(teamDir, ".git", "config"), "utf8"));
  // generated agent config at the workspace root
  texts.push(readFileSync(join(ws, "CLAUDE.md"), "utf8"));
  texts.push(readFileSync(join(ws, ".claude", "settings.json"), "utf8"));
  // session files
  const sessDir = join(ws, ".sessions");
  try {
    for (const f of readdirSync(sessDir)) texts.push(readFileSync(join(sessDir, f), "utf8"));
  } catch {
    /* no sessions dir */
  }
  return texts;
}

describe("SECRETS INVARIANT [release-gate:secrets]: keychain values never leak into synced/committed/config/session artifacts", () => {
  // Generous timeout: this lifecycle spins up a bare remote + working clone with real git (~5s on its
  // own), but runs alongside the rest of a large, git- and jsdom-heavy suite. Under that parallel load
  // the real-git I/O is starved well past the 5s default, so we allow ample wall-clock. The assertion
  // set (a full secret scan of every artifact) is unchanged - only the time budget is relaxed.
  it("holds across a full workspace lifecycle", async () => {
    // a bare remote + a team working clone (the synced repo)
    const remote = join(base, "remote.git");
    git(["init", "--bare", "--initial-branch=main", remote], base);
    const seed = join(base, "seed");
    git(["clone", `file://${remote}`, seed], base);
    writeFileSync(join(seed, "readme.md"), "seed\n");
    git(["add", "."], seed);
    git(["commit", "-m", "seed"], seed);
    git(["push", "origin", "HEAD:main"], seed);

    const team = join(ws, "team");
    git(["clone", `file://${remote}`, team], ws);

    // secrets live ONLY in the keychain
    const keychain = new InMemoryKeychain();
    keychain.set("connector:gmail", SECRET);
    keychain.set("org:demo:machine-token", TOKEN);

    // a core root with rules (no secret) + generate the native agent config at the workspace root
    const core = join(base, "core");
    mkdirSync(join(core, "skills", "tidy"), { recursive: true });
    writeFileSync(join(core, "CLAUDE.md"), "core rules\n");
    writeFileSync(join(core, "skills", "tidy", "SKILL.md"), "tidy\n");
    const roots: Root[] = [
      { name: "core", dir: core },
      { name: "team", dir: team },
      { name: "private", dir: join(base, "private") },
    ];
    mkdirSync(roots[2]!.dir, { recursive: true });
    generateAgentConfig({ workspace: ws, roots, preset, gateCommand: "buildex-gate --port 7777" });

    // the operator does real work and it syncs
    writeFileSync(join(team, "conventions.md"), "# our conventions\n");
    await new SyncEngine({ now: () => 1, actor: "operator" }).publish(team);

    // a chat session records agent events (never secrets)
    const sessions = new FileSessionStore(join(ws, ".sessions"));
    const sid = sessions.create();
    sessions.append(sid, { kind: "text", text: "drafting the plan" });
    sessions.append(sid, { kind: "tool", id: "t1", name: "Read", input: { file_path: "conventions.md" } });
    sessions.setClaudeSessionId(sid, "claude-session-xyz");

    // NOTHING anywhere contains the secret or the token
    for (const text of scanTargets(team)) {
      expect(text.includes(SECRET)).toBe(false);
      expect(text.includes(TOKEN)).toBe(false);
    }
    // and the remote URL is a plain file:// (no token embedded - the harden)
    expect(readFileSync(join(team, ".git", "config"), "utf8")).not.toContain("@");
  }, 60000);
});
