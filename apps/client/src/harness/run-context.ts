// The engine's workspace lifecycle. A run gets one directory: <baseDir>/<slug>/ holding workspace/
// (the throwaway three-root BuildEx workspace - deleted at teardown) beside the artifacts the run
// leaves behind (transcripts, results.json - the only thing that survives, per the clean-slate
// contract in docs/sandbox-face.md).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { seedAcmeWorkspace } from "../demo/acme-seed.js";
import type { Root } from "../brain/graph.js";

export interface RunContext {
  runDir: string;
  workspace: string;
  roots: Root[];
}

export function provisionRunContext(opts: { baseDir: string; corePackDir: string; slug: string }): RunContext {
  const runDir = join(opts.baseDir, opts.slug);
  const workspace = join(runDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const roots = seedAcmeWorkspace({ workspace, corePackDir: opts.corePackDir });
  return { runDir, workspace, roots };
}

/** Remove the throwaway workspace; artifacts in runDir survive. The provider-side teardown is the
 *  sandbox step's job - this only owns local disk. */
export function teardownRunContext(ctx: RunContext): void {
  // maxRetries: Windows EBUSY insurance - a just-exited child process (agent, git) can hold the
  // directory open a beat longer than rmSync's first attempt expects.
  rmSync(ctx.workspace, { recursive: true, force: true, maxRetries: 3 });
}
