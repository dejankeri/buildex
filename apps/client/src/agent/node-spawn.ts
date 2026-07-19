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
  const appendTail = (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]);
    // Copy (not subarray) so the oversized backing buffer is released.
    if (tail.length > STDERR_TAIL_BYTES) tail = Buffer.from(tail.subarray(tail.length - STDERR_TAIL_BYTES));
  };
  child.stderr.on("data", appendTail);

  // The spawn can fail asynchronously - most importantly ENOENT when the agent binary isn't on PATH
  // (a Finder-launched macOS app inherits a bare PATH, so `claude` from ~/.local/bin or Homebrew is
  // invisible). Node emits 'error' on the child for that; with NO listener it becomes an uncaught
  // exception that crashes the whole app. Handle it: fold the reason into the stderr tail (so the
  // driver's failure path can show "spawn claude ENOENT") and settle `exit` non-zero. 'error' and
  // 'close' can both fire, so latch on the first. Swallow late stdio-stream errors for the same
  // no-crash reason - the async iterator over stdout just ends empty.
  let settle: (code: number | null) => void;
  const exit = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const settleOnce = (code: number | null) => {
    if (settled) return;
    settled = true;
    settle(code);
  };
  child.on("error", (err) => {
    appendTail(Buffer.from(`spawn ${spec.command} ${(err as NodeJS.ErrnoException).code ?? err.message}\n`));
    settleOnce(127); // "command not found" convention; any non-zero drives detect()→unavailable
  });
  child.on("close", (code) => settleOnce(code));
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  return {
    stdout: child.stdout,
    exit,
    kill: () => {
      child.kill();
    },
    stderrTail: () => tail.toString("utf8"),
  };
};
