// The AgentDriver seam. This interface abstracts *how* an agent's activity is
// captured, so the mechanism can differ per tier (Tier-1 Claude = stream-json; Tier-2 = PTY+hooks,
// post-v1) without touching consumers. Consumers (daemon, map, gate) only ever see UiEvents.

/** A single structured event from an agent turn. Rendered to the live map + chat; gated at `tool`. */
export type UiEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; path?: string }
  | { kind: "tool_result"; id: string; name: string; ok: boolean; output?: string }
  | { kind: "done"; sessionId?: string }
  | { kind: "error"; message: string };

/** True once a turn has ended (no more events will follow). */
export function isTerminal(e: UiEvent): boolean {
  return e.kind === "done" || e.kind === "error";
}

export interface DetectResult {
  available: boolean;
  version?: string;
  path?: string;
}

export interface RunPromptOpts {
  prompt: string;
  /** Absolute path to the workspace root; the agent runs with this as its cwd. */
  workspace: string;
  /** Resume a prior session by id (driver-owned; never synced). */
  resume?: string;
  /** An allowlisted model id, or undefined for the agent's default. */
  model?: string;
  /** Extra text appended to the agent's system prompt (e.g. the workspace file map, so the agent can
   *  navigate by Read even where Glob/Grep/Bash are unavailable). Passed via --append-system-prompt. */
  systemPromptAppend?: string;
  /** Abort the turn (kills the underlying process). */
  signal?: AbortSignal;
}

/**
 * A capture driver for one agent tier. `detect()` reports availability; `runPrompt` streams a
 * turn as UiEvents. The driver NEVER reads or proxies model credentials (conductor bright-lines,
 * invariant 4) - it spawns the operator's own CLI, which authenticates itself.
 */
export interface AgentDriver {
  detect(): Promise<DetectResult>;
  runPrompt(opts: RunPromptOpts): AsyncIterable<UiEvent>;
}
