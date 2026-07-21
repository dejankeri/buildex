// The production spawn adapter for the agent driver - real child_process. Kept thin and separate so
// the driver stays hermetically testable with a fake spawn. Passes the operator's environment
// through unchanged (the agent CLI authenticates itself; buildex never injects provider keys - the
// conductor bright-line lives in the driver's arg building, not here).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AgentProcess, SpawnAgent } from "./claude-driver.js";
import { resolveWin32Command, type ResolvedCommand } from "./win32-resolve.js";

/** How much of the child's stderr we keep for diagnostics (the tail; everything older is dropped). */
export const STDERR_TAIL_BYTES = 8 * 1024;

/** Deps for the launch decision. Injected (rather than read from the ambient process) so the win32
 *  branch is exercised by the suite on macOS and Linux too - the Windows paths in this repo are
 *  semantics, not a runtime, and an untested platform branch is how the `.cmd` gap shipped. */
export interface LaunchDeps {
  platform: NodeJS.Platform | string;
  path?: string | undefined;
  pathExt?: string | undefined;
  exists: (p: string) => boolean;
  readFile: (p: string) => string;
}

/** What to actually hand `spawn()`. On win32 a bare command may be an npm `.cmd` shim that libuv's
 *  `.com`/`.exe`-only PATH probe cannot see; resolve it to the real executable. Everywhere else -
 *  and whenever resolution is not confident - this is the identity, so behaviour is never worse. */
export function launchCommand(command: string, args: string[], deps: LaunchDeps): ResolvedCommand {
  if (deps.platform !== "win32") return { command, args };
  return resolveWin32Command(command, args, deps) ?? { command, args };
}

export const nodeSpawnAgent: SpawnAgent = (spec): AgentProcess => {
  // Resolve against the env the child will actually get (the driver may hand us one), not ambient.
  const env = spec.env ?? process.env;
  const launch = launchCommand(spec.command, spec.args, {
    platform: process.platform,
    path: env["PATH"] ?? env["Path"],
    pathExt: env["PATHEXT"] ?? env["PathExt"],
    exists: existsSync,
    readFile: (p) => readFileSync(p, "utf8"),
  });
  const child = spawn(launch.command, launch.args, {
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
