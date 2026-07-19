import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { ClaudeCodeDriver, type SpawnAgent, type AgentProcess } from "./claude-driver.js";
import type { UiEvent } from "./types.js";

// A fake spawn that streams recorded stream-json lines then exits with `code`.
function fakeSpawn(lines: string[], code: number | null = 0) {
  const calls: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
  const spawn: SpawnAgent = (spec): AgentProcess => {
    calls.push(spec);
    return {
      stdout: Readable.from(lines.map((l) => l + "\n")),
      exit: Promise.resolve(code),
      kill() {},
    };
  };
  return { spawn, calls };
}

const line = (o: unknown) => JSON.stringify(o);
const TRANSCRIPT = [
  line({ type: "system", subtype: "init", session_id: "s1" }),
  line({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/ws/a.md" } }] } }),
  line({ type: "result", subtype: "success", result: "ok", session_id: "s1" }),
];

async function collect(it: AsyncIterable<UiEvent>): Promise<UiEvent[]> {
  const out: UiEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("ClaudeCodeDriver.runPrompt", () => {
  it("streams parsed UiEvents from the agent's stdout", async () => {
    const { spawn } = fakeSpawn(TRANSCRIPT);
    const driver = new ClaudeCodeDriver({ spawn, bin: "claude" });
    const events = await collect(driver.runPrompt({ prompt: "hi", workspace: "/ws" }));
    expect(events).toContainEqual({ kind: "text", text: "working" });
    expect(events.some((e) => e.kind === "tool" && e.path === "a.md")).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "done", sessionId: "s1" });
  });

  it("spawns with cwd=workspace and the stream-json flags, plus resume/model when given", async () => {
    const { spawn, calls } = fakeSpawn(TRANSCRIPT);
    const driver = new ClaudeCodeDriver({ spawn, bin: "claude" });
    await collect(driver.runPrompt({ prompt: "do it", workspace: "/ws", resume: "s0", model: "claude-x" }));
    const spec = calls[0]!;
    expect(spec.cwd).toBe("/ws");
    expect(spec.args).toEqual(expect.arrayContaining(["-p", "do it", "--output-format", "stream-json", "--verbose", "--resume", "s0", "--model", "claude-x"]));
  });

  it("passes the workspace file map via --append-system-prompt when given", async () => {
    const { spawn, calls } = fakeSpawn(TRANSCRIPT);
    const driver = new ClaudeCodeDriver({ spawn, bin: "claude" });
    await collect(driver.runPrompt({ prompt: "go", workspace: "/ws", systemPromptAppend: "files:\nteam/a.md" }));
    const args = calls[0]!.args;
    const i = args.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toContain("team/a.md");
  });

  it("spawns with an isolated CLAUDE_CONFIG_DIR when configDir is set (still no provider key)", async () => {
    const { spawn, calls } = fakeSpawn(TRANSCRIPT);
    const driver = new ClaudeCodeDriver({ spawn, bin: "claude", configDir: "/iso/agent" });
    await collect(driver.runPrompt({ prompt: "x", workspace: "/ws" }));
    const env = calls[0]!.env ?? {};
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/iso/agent");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("honors the conductor bright-line: never injects a provider API key", async () => {
    const { spawn, calls } = fakeSpawn(TRANSCRIPT);
    const driver = new ClaudeCodeDriver({ spawn, bin: "claude" });
    await collect(driver.runPrompt({ prompt: "x", workspace: "/ws" }));
    const env = calls[0]!.env ?? {};
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("emits an error event when the agent exits non-zero without a result frame", async () => {
    const { spawn } = fakeSpawn([line({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } })], 1);
    const driver = new ClaudeCodeDriver({ spawn, bin: "claude" });
    const events = await collect(driver.runPrompt({ prompt: "x", workspace: "/ws" }));
    expect(events.at(-1)?.kind).toBe("error");
  });

  it("attaches the process's stderr tail to the error event on a non-zero exit", async () => {
    const spawn: SpawnAgent = (): AgentProcess => ({
      stdout: Readable.from([]),
      exit: Promise.resolve(1),
      kill() {},
      stderrTail: () => "Error: MCP server 'foo' crashed\n",
    });
    const driver = new ClaudeCodeDriver({ spawn, bin: "claude" });
    const events = await collect(driver.runPrompt({ prompt: "x", workspace: "/ws" }));
    const last = events.at(-1)!;
    expect(last.kind).toBe("error");
    expect(last).toMatchObject({ message: expect.stringContaining("agent exited 1") });
    expect(last).toMatchObject({ message: expect.stringContaining("MCP server 'foo' crashed") });
  });

  it("stays terse when the process exposes no stderr tail (or an empty one)", async () => {
    const spawn: SpawnAgent = (): AgentProcess => ({
      stdout: Readable.from([]),
      exit: Promise.resolve(2),
      kill() {},
      stderrTail: () => "  \n",
    });
    const driver = new ClaudeCodeDriver({ spawn, bin: "claude" });
    const events = await collect(driver.runPrompt({ prompt: "x", workspace: "/ws" }));
    expect(events.at(-1)).toEqual({ kind: "error", message: "agent exited 2" });
  });
});

describe("ClaudeCodeDriver.detect", () => {
  it("reports available + version when `claude --version` succeeds", async () => {
    const { spawn, calls } = fakeSpawn(["1.2.3 (Claude Code)"], 0);
    const driver = new ClaudeCodeDriver({ spawn, bin: "claude" });
    const res = await driver.detect();
    expect(res.available).toBe(true);
    expect(res.version).toContain("1.2.3");
    expect(calls[0]!.args).toContain("--version");
  });

  it("reports unavailable when the binary exits non-zero", async () => {
    const { spawn } = fakeSpawn([""], 127);
    const driver = new ClaudeCodeDriver({ spawn, bin: "claude" });
    expect((await driver.detect()).available).toBe(false);
  });
});
