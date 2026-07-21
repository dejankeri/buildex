import { describe, it, expect } from "vitest";
import { win32 } from "node:path";
import { nodeSpawnAgent, STDERR_TAIL_BYTES, launchCommand, type LaunchDeps } from "./node-spawn.js";

describe("nodeSpawnAgent", () => {
  it("spawns a real process and streams its stdout", async () => {
    const proc = nodeSpawnAgent({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello world')"],
      cwd: process.cwd(),
    });
    let out = "";
    for await (const chunk of proc.stdout) out += chunk.toString();
    expect(out).toBe("hello world");
    expect(await proc.exit).toBe(0);
  });

  it("reports a non-zero exit code", async () => {
    const proc = nodeSpawnAgent({ command: process.execPath, args: ["-e", "process.exit(3)"], cwd: process.cwd() });
    for await (const _ of proc.stdout) void _;
    expect(await proc.exit).toBe(3);
  });

  it("does not stall when the child writes far more than the pipe buffer to stderr", async () => {
    // 1MB of stderr - well past the ~64KB pipe buffer. Without a continuous drain the child
    // would block on write and this turn would never finish.
    const proc = nodeSpawnAgent({
      command: process.execPath,
      args: ["-e", "process.stderr.write('x'.repeat(1024 * 1024)); process.stdout.write('done')"],
      cwd: process.cwd(),
    });
    let out = "";
    for await (const chunk of proc.stdout) out += chunk.toString();
    expect(out).toBe("done");
    expect(await proc.exit).toBe(0);
  }, 15_000);

  it("keeps only a bounded stderr tail, ending with the most recent output", async () => {
    const proc = nodeSpawnAgent({
      command: process.execPath,
      args: ["-e", "process.stderr.write('x'.repeat(1024 * 1024) + 'THE-END')"],
      cwd: process.cwd(),
    });
    for await (const _ of proc.stdout) void _;
    await proc.exit;
    const tail = proc.stderrTail!();
    expect(tail.length).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
    expect(tail.endsWith("THE-END")).toBe(true);
  }, 15_000);

  it("captures small stderr output verbatim in the tail", async () => {
    const proc = nodeSpawnAgent({
      command: process.execPath,
      args: ["-e", "process.stderr.write('warn: something odd'); process.exit(2)"],
      cwd: process.cwd(),
    });
    for await (const _ of proc.stdout) void _;
    expect(await proc.exit).toBe(2);
    expect(proc.stderrTail!()).toBe("warn: something odd");
  });

  it("does not crash on a missing binary - settles non-zero and records the reason", async () => {
    // The Finder-launched-app failure mode: `claude` not on PATH. Node emits 'error' (ENOENT) on the
    // child; without our handler that is an uncaught exception that takes down the whole app. Here it
    // must resolve to a normal non-zero exit with the reason in the tail, so detect()/runPrompt can
    // report "unavailable" instead of crashing. If this leaked as an unhandled 'error', the test run
    // itself would abort.
    const proc = nodeSpawnAgent({
      command: "definitely-not-a-real-binary-xyz",
      args: ["--version"],
      cwd: process.cwd(),
    });
    let out = "";
    for await (const chunk of proc.stdout) out += chunk.toString();
    expect(out).toBe(""); // stdout just ends empty
    const code = await proc.exit;
    expect(code).not.toBe(0);
    expect(proc.stderrTail!()).toContain("ENOENT");
  });
});

describe("launchCommand - the win32 .cmd-shim seam", () => {
  const SHIM_DIR = "C:\\Users\\op\\AppData\\Roaming\\npm";
  const NODE_DIR = "C:\\Program Files\\nodejs";
  const SHIM = 'endLocal & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*';

  function deps(platform: string): LaunchDeps {
    const files: Record<string, string> = {
      [win32.join(SHIM_DIR, "claude.cmd")]: SHIM,
      [win32.join(NODE_DIR, "node.exe")]: "",
    };
    return {
      platform,
      path: [SHIM_DIR, NODE_DIR].join(";"),
      pathExt: ".COM;.EXE;.BAT;.CMD",
      exists: (p) => p in files,
      readFile: (p) => files[p] ?? (() => { throw new Error("ENOENT"); })(),
    };
  }

  it("resolves an npm .cmd shim to node.exe + cli.js on win32", () => {
    expect(launchCommand("claude", ["-p", "hi"], deps("win32"))).toEqual({
      command: win32.join(NODE_DIR, "node.exe"),
      args: [win32.join(SHIM_DIR, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), "-p", "hi"],
    });
  });

  it("is the identity on darwin/linux - a POSIX host must never take the shim path", () => {
    for (const platform of ["darwin", "linux"]) {
      expect(launchCommand("claude", ["-p", "hi"], deps(platform))).toEqual({
        command: "claude",
        args: ["-p", "hi"],
      });
    }
  });

  it("falls back to the original command when win32 resolution finds nothing (never worse)", () => {
    expect(launchCommand("not-installed", ["--version"], deps("win32"))).toEqual({
      command: "not-installed",
      args: ["--version"],
    });
  });
});
