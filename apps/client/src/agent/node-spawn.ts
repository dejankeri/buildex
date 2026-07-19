// The production spawn adapter for the agent driver - real child_process. Kept thin and separate so
// the driver stays hermetically testable with a fake spawn. Passes the operator's environment
// through unchanged (the agent CLI authenticates itself; buildex never injects provider keys - the
// conductor bright-line lives in the driver's arg building, not here).
import { spawn } from "node:child_process";
import type { AgentProcess, SpawnAgent } from "./claude-driver.js";

/** How much of the child's stderr we keep for diagnostics (the tail; everything older is dropped). */
export const STDERR_TAIL_BYTES = 8 * 1024;

export const nodeSpawnAgent: SpawnAgent = (spec): AgentProcess => {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    ...(spec.env ? { env: spec.env } : {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain stderr continuously so the pipe can never fill and block the child (a stalled turn has
  // no timeout anywhere above this). Keep only a bounded tail for diagnostics.
  let tail = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]);
    // Copy (not subarray) so the oversized backing buffer is released.
    if (tail.length > STDERR_TAIL_BYTES) tail = Buffer.from(tail.subarray(tail.length - STDERR_TAIL_BYTES));
  });
  return {
    stdout: child.stdout,
    exit: new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code))),
    kill: () => {
      child.kill();
    },
    stderrTail: () => tail.toString("utf8"),
  };
};
