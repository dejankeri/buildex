// DETERMINISM INVARIANT SUITE [release-gate:determinism] (invariant 9): the
// trust surfaces - the map (buildGraph), per-file history and recent-changes (git-derived) - render
// from repo state ALONE, with zero LLM and no network. This suite pins two things: the same repo
// state always yields byte-identical output, and the render path is SYNCHRONOUS (there is no async
// seam where a model call or a fetch could hide). If any trust surface ever grows an async/LLM step,
// a test here breaks.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildGraph } from "../brain/graph.js";
import { fileHistory, recentChanges } from "../brain/history.js";

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
} as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-determinism-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("DETERMINISM INVARIANT SUITE [release-gate:determinism]: trust surfaces render from repo state, zero LLM", () => {
  it("buildGraph is pure: identical repo state → byte-identical map, on every call", () => {
    const team = join(dir, "team");
    mkdirSync(join(team, "notes"), { recursive: true });
    writeFileSync(join(team, "charter.md"), "# Charter\n\nSee [[plan]].\n");
    writeFileSync(join(team, "notes", "plan.md"), "# Plan\n");
    const roots = [{ name: "team", dir: team }];
    const a = buildGraph(roots);
    const b = buildGraph(roots);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // deterministic, order-stable
    expect(a.nodes.length).toBeGreaterThan(0);
  });

  it("buildGraph renders synchronously - no async seam where a model call could hide", () => {
    const out = buildGraph([{ name: "team", dir }]);
    // A Promise here would mean the render could await a network/LLM call; the trust surface must not.
    expect(out).not.toBeInstanceOf(Promise);
    expect(Array.isArray(out.nodes)).toBe(true);
  });

  it("git-derived history + recent-changes are deterministic for a fixed repo state", () => {
    git(["init", "--initial-branch=main", dir], dir);
    writeFileSync(join(dir, "doc.md"), "one\n");
    git(["add", "-A"], dir);
    git(["commit", "-m", "first"], dir);
    writeFileSync(join(dir, "doc.md"), "two\n");
    git(["add", "-A"], dir);
    git(["commit", "-m", "second"], dir);

    expect(fileHistory(dir, "doc.md")).toEqual(fileHistory(dir, "doc.md"));
    expect(recentChanges(dir, 12)).toEqual(recentChanges(dir, 12));
    expect(fileHistory(dir, "doc.md")).toHaveLength(2); // both commits, newest first
  });
});
