// Ground truth for one deterministic run. The agent's real effect on the workspace is whatever it
// committed DURING the run - so results reads that straight off each root's git history
// (recentChanges - zero LLM, invariant 9) rather than trusting the agent's own narration of what it
// did. install/sandbox/drive verdicts are folded in alongside, then the whole thing is the one
// results.json artifact a run leaves behind.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { recentChanges } from "../brain/history.js";
import type { RunContext } from "./run-context.js";
import type { InstallCheck } from "./install-step.js";
import type { DriveResult } from "./drive-step.js";

export interface DeterministicResults {
  runAt: string;
  pack: string;
  install: InstallCheck;
  sandbox: { minted: boolean; destroyed: boolean };
  drives: { caseId: string; toolCalls: number; toolFailures: number; errored: boolean }[];
  /** Each root's recent history (up to 200 per root) - the harness's own `seed <root>` bootstrap
   *  commits are in here alongside anything the agent committed. Consumers separate them by subject;
   *  count is NOT "the agent's commit count". */
  commits: { root: string; count: number; subjects: string[] }[];
}

export function collectResults(opts: {
  pack: string;
  ctx: RunContext;
  install: InstallCheck;
  sandbox: { minted: boolean; destroyed: boolean };
  drives: DriveResult[];
  now?: () => Date;
}): DeterministicResults {
  const now = opts.now ?? (() => new Date());

  const commits = opts.ctx.roots.map((root) => {
    const changes = recentChanges(root.dir, 200);
    return { root: root.name, count: changes.length, subjects: changes.map((c) => c.subject) };
  });

  const drives = opts.drives.map((d) => ({
    caseId: d.caseId,
    toolCalls: d.toolCalls,
    toolFailures: d.toolFailures,
    errored: d.errored,
  }));

  return {
    runAt: now().toISOString(),
    pack: opts.pack,
    install: opts.install,
    sandbox: opts.sandbox,
    drives,
    commits,
  };
}

/** Write the run's one surviving artifact: `<runDir>/results.json`. Returns the path. */
export function writeResults(runDir: string, r: DeterministicResults): string {
  const path = join(runDir, "results.json");
  writeFileSync(path, JSON.stringify(r, null, 2) + "\n");
  return path;
}
