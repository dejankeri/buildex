import { describe, it, expect } from "vitest";
import { nodeSpawnAgent, STDERR_TAIL_BYTES } from "./node-spawn.js";

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
});
