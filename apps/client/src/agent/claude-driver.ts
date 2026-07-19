// Tier-1 driver: Claude Code via `--output-format stream-json`. Ported
// and hardened from the prototype's driver. Conductor bright-lines (invariant 4): it spawns the
// operator's own `claude` CLI, which authenticates itself - the driver NEVER sets a provider API
// key, never reads a credential store. Spawn is injected so the whole driver is hermetically testable.
import { Readable } from "node:stream";
import type { AgentDriver, DetectResult, RunPromptOpts, UiEvent } from "./types.js";
import { isTerminal } from "./types.js";
import { ClaudeStreamParser } from "./parser.js";

/** A spawned agent process, reduced to what the driver consumes. */
export interface AgentProcess {
  stdout: Readable;
  exit: Promise<number | null>;
  kill(): void;
  /** The tail of the child's stderr so far (bounded; for diagnostics on failure). Optional so fake
   *  spawns in tests stay minimal. */
  stderrTail?(): string;
}

export type SpawnAgent = (spec: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}) => AgentProcess;

export interface ClaudeDriverDeps {
  spawn: SpawnAgent;
  /** The resolved `claude` binary (or just "claude" to use PATH). */
  bin: string;
  /** If set, `runPrompt` rejects any model id not in this allowlist (the `--model` security boundary). */
  allowedModels?: string[];
  /** If set, spawn the agent with CLAUDE_CONFIG_DIR pointed here - a config home isolated from the
   *  operator's own Claude Code (no inherited hooks), so BuildEx's agent gets a clean, predictable tool
   *  set. Still NOT a credential seam: the driver never sets a provider key (conductor bright-line). */
  configDir?: string;
}

export class ClaudeCodeDriver implements AgentDriver {
  constructor(private readonly deps: ClaudeDriverDeps) {}

  async detect(): Promise<DetectResult> {
    const proc = this.deps.spawn({ command: this.deps.bin, args: ["--version"], cwd: process.cwd() });
    let out = "";
    for await (const chunk of proc.stdout) out += chunk.toString();
    const code = await proc.exit;
    if (code !== 0) return { available: false };
    return { available: true, version: out.trim(), path: this.deps.bin };
  }

  async *runPrompt(opts: RunPromptOpts): AsyncIterable<UiEvent> {
    const args = this.buildArgs(opts);
    const parser = new ClaudeStreamParser({ workspace: opts.workspace });
    // Only pass an env when we need to (an isolated config dir); never inject a provider key.
    const env = this.deps.configDir ? { ...process.env, CLAUDE_CONFIG_DIR: this.deps.configDir } : undefined;
    const proc = this.deps.spawn({ command: this.deps.bin, args, cwd: opts.workspace, ...(env ? { env } : {}) });
    if (opts.signal) opts.signal.addEventListener("abort", () => proc.kill(), { once: true });

    let sawTerminal = false;
    try {
      for await (const chunk of proc.stdout) {
        for (const e of parser.push(chunk.toString())) {
          if (isTerminal(e)) sawTerminal = true;
          yield e;
        }
      }
      for (const e of parser.end()) {
        if (isTerminal(e)) sawTerminal = true;
        yield e;
      }
      const code = await proc.exit;
      if (!sawTerminal) {
        if (code === 0) {
          yield { kind: "done" };
        } else {
          const tail = proc.stderrTail?.().trim();
          yield { kind: "error", message: tail ? `agent exited ${code}\nstderr tail:\n${tail}` : `agent exited ${code}` };
        }
      }
    } catch (e) {
      yield { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  private buildArgs(opts: RunPromptOpts): string[] {
    const args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
    if (opts.systemPromptAppend) args.push("--append-system-prompt", opts.systemPromptAppend);
    if (opts.resume) args.push("--resume", opts.resume);
    if (opts.model) {
      if (this.deps.allowedModels && !this.deps.allowedModels.includes(opts.model)) {
        throw new Error(`model not allowed: ${opts.model}`);
      }
      args.push("--model", opts.model);
    }
    return args;
  }
}
