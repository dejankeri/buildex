// Ground truth for a deterministic run: commits made DURING the run (via recentChanges - zero LLM,
// read straight off the repos) plus the install/drive/sandbox verdicts, written to results.json.
// Hermetic: real tiny git repos in a tmpdir, no network, no agent.
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectResults, writeResults } from "./results.js";
import type { RunContext } from "./run-context.js";
import type { InstallCheck } from "./install-step.js";
import type { DriveResult } from "./drive-step.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// Deterministic commit identity, independent of the machine's global git config (mirrors
// provision/core-pack.ts's initAndCommit / demo/acme-seed.ts's usage of it).
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@buildex.local",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@buildex.local",
};

/** Init a tiny real repo + one commit via execSync, so recentChanges has something to read. */
function seedRepo(dir: string, subject: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init --initial-branch=main", { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  execSync("git config user.email t@buildex.local", { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  execSync("git config user.name t", { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  writeFileSync(join(dir, "note.md"), "hello\n");
  execSync("git add -A", { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  execSync(`git commit -m "${subject}"`, { cwd: dir, env: GIT_ENV, stdio: "ignore" });
}

const INSTALL: InstallCheck = { app: true, skills: [{ name: "acme-howto", present: true }], policyFragment: true, ok: true };

describe("collectResults", () => {
  it("reads recentChanges per root and surfaces the commit subjects (the agent's ground truth)", () => {
    const base = tmp("results-");
    const teamDir = join(base, "team-acme");
    seedRepo(teamDir, "seed team-acme");
    const privDir = join(base, "private-you");
    seedRepo(privDir, "seed private-you");

    const ctx: RunContext = {
      runDir: base,
      workspace: join(base, "workspace"),
      roots: [
        { name: "team-acme", dir: teamDir },
        { name: "private-you", dir: privDir },
      ],
    };
    const drives: DriveResult[] = [
      { caseId: "smoke-1", events: [], toolCalls: 3, toolFailures: 1, errored: false, transcriptPath: "x" },
    ];

    const results = collectResults({
      pack: "acme",
      ctx,
      install: INSTALL,
      sandbox: { minted: false, destroyed: false },
      drives,
      now: () => new Date("2026-07-22T10:00:00Z"),
    });

    expect(results.runAt).toBe("2026-07-22T10:00:00.000Z");
    expect(results.pack).toBe("acme");
    expect(results.install).toEqual(INSTALL);
    expect(results.sandbox).toEqual({ minted: false, destroyed: false });

    expect(results.commits).toHaveLength(2);
    const team = results.commits.find((c) => c.root === "team-acme");
    expect(team?.count).toBeGreaterThanOrEqual(1);
    expect(team?.subjects).toContain("seed team-acme");
    const priv = results.commits.find((c) => c.root === "private-you");
    expect(priv?.subjects).toContain("seed private-you");

    expect(results.drives).toEqual([{ caseId: "smoke-1", toolCalls: 3, toolFailures: 1, errored: false }]);
  });

  it("reports zero commits for a root with no history", () => {
    const base = tmp("results-empty-");
    const emptyDir = join(base, "core");
    mkdirSync(emptyDir, { recursive: true }); // no .git at all - recentChanges must fail soft
    const ctx: RunContext = { runDir: base, workspace: join(base, "workspace"), roots: [{ name: "core", dir: emptyDir }] };

    const results = collectResults({
      pack: "acme",
      ctx,
      install: INSTALL,
      sandbox: { minted: false, destroyed: false },
      drives: [],
    });

    expect(results.commits).toEqual([{ root: "core", count: 0, subjects: [] }]);
    expect(results.drives).toEqual([]);
  });

  it("fails soft on an INITIALIZED repo with zero commits (git exists, no HEAD yet)", () => {
    const base = tmp("results-init-");
    const bareInit = join(base, "core");
    mkdirSync(bareInit, { recursive: true });
    execSync("git init --initial-branch=main", { cwd: bareInit, env: GIT_ENV, stdio: "ignore" });
    const ctx: RunContext = { runDir: base, workspace: join(base, "workspace"), roots: [{ name: "core", dir: bareInit }] };

    const results = collectResults({ pack: "acme", ctx, install: INSTALL, sandbox: { minted: false, destroyed: false }, drives: [] });
    expect(results.commits).toEqual([{ root: "core", count: 0, subjects: [] }]);
  });
});

describe("writeResults", () => {
  it("round-trips the JSON to <runDir>/results.json", () => {
    const runDir = tmp("results-write-");
    const ctx: RunContext = { runDir, workspace: join(runDir, "workspace"), roots: [] };
    const r = collectResults({
      pack: "protocol",
      ctx,
      install: INSTALL,
      sandbox: { minted: true, destroyed: true },
      drives: [],
      now: () => new Date("2026-07-22T10:00:00Z"),
    });

    const p = writeResults(runDir, r);
    expect(p).toBe(join(runDir, "results.json"));
    const roundtrip = JSON.parse(readFileSync(p, "utf8"));
    expect(roundtrip).toEqual(r);
  });
});
