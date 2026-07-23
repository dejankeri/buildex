// Stateful parser for Claude Code's `--output-format stream-json`. It is a line
// reader tolerant of partial frames: `push(chunk)` returns whatever complete UiEvents the chunk
// finished. It normalizes absolute tool file-paths to workspace-relative (so the live map can match
// them) and retains tool-use id→name so results can be labeled. Ported/hardened from the prototype
// (which had ~120 happy-path lines and no partial-frame or error tolerance).
import { relative, isAbsolute } from "node:path";
import type { UiEvent } from "./types.js";
import { toPosix } from "../lib/to-posix.js";

interface StreamContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
interface StreamLine {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: StreamContentBlock[] };
  /** On the final `result` line: what the turn cost and how long it took. Both optional - an older
   *  CLI, or one that ended badly, may report neither. */
  total_cost_usd?: unknown;
  duration_ms?: unknown;
}

export class ClaudeStreamParser {
  private buf = "";
  private sessionId: string | undefined;
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly opts: { workspace: string }) {}

  /** Feed a chunk of stdout; returns the UiEvents whose frames completed within it. */
  push(chunk: string): UiEvent[] {
    this.buf += chunk;
    const events: UiEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) events.push(...this.handleLine(line));
    }
    return events;
  }

  /** Flush any trailing partial line at stream end. */
  end(): UiEvent[] {
    if (!this.buf.trim()) return [];
    const line = this.buf;
    this.buf = "";
    return this.handleLine(line);
  }

  private handleLine(line: string): UiEvent[] {
    let obj: StreamLine;
    try {
      obj = JSON.parse(line) as StreamLine;
    } catch {
      return [{ kind: "error", message: "unparseable stream line" }];
    }

    if (obj.session_id) this.sessionId = obj.session_id;

    switch (obj.type) {
      case "system":
        return []; // init: session id already captured above
      case "assistant":
        return this.handleAssistant(obj);
      case "user":
        return this.handleUser(obj);
      case "result":
        if (obj.subtype && obj.subtype !== "success") {
          return [{ kind: "error", message: `agent result: ${obj.subtype}` }];
        }
        // The `result` line is the only place the agent prices its own work. Carrying it on `done`
        // is what lets a loop record what a run cost - and a spending limit mean anything.
        return [
          {
            kind: "done",
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...num(obj.total_cost_usd, (v) => ({ costUsd: v })),
            ...num(obj.duration_ms, (v) => ({ ms: v })),
          },
        ];
      default:
        return [];
    }
  }

  private handleAssistant(obj: StreamLine): UiEvent[] {
    const events: UiEvent[] = [];
    for (const block of obj.message?.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        events.push({ kind: "text", text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        events.push({ kind: "thinking", text: block.thinking });
      } else if (block.type === "tool_use" && block.id && block.name) {
        this.toolNames.set(block.id, block.name);
        const path = this.extractPath(block.input);
        events.push({
          kind: "tool",
          id: block.id,
          name: block.name,
          input: block.input ?? {},
          ...(path ? { path } : {}),
        });
      }
    }
    return events;
  }

  private handleUser(obj: StreamLine): UiEvent[] {
    const events: UiEvent[] = [];
    for (const block of obj.message?.content ?? []) {
      if (block.type === "tool_result" && block.tool_use_id) {
        events.push({
          kind: "tool_result",
          id: block.tool_use_id,
          name: this.toolNames.get(block.tool_use_id) ?? "unknown",
          ok: block.is_error !== true,
          output: stringifyContent(block.content),
        });
      }
    }
    return events;
  }

  /** Pull the primary file path from a tool input and normalize it to workspace-relative. */
  private extractPath(input: Record<string, unknown> | undefined): string | undefined {
    if (!input) return undefined;
    const raw = input["file_path"] ?? input["path"] ?? input["notebook_path"];
    if (typeof raw !== "string") return undefined;
    if (isAbsolute(raw)) {
      const rel = relative(this.opts.workspace, raw);
      // Only relativize paths that stay inside the workspace; otherwise leave absolute. Normalize to
      // forward slashes: on Windows `relative` yields backslashes, but the live map keys every file
      // POSIX-style (brain/graph.ts toPosix), so an un-normalized path would never match it.
      if (!rel.startsWith("..") && !isAbsolute(rel)) return toPosix(rel);
      return raw;
    }
    return raw;
  }
}

/** Emit `shape(v)` only for a finite, non-negative number. A stream field is whatever the CLI put
 *  there; a string or a NaN must not become a cost the operator is shown or a limit is measured on. */
function num<T>(raw: unknown, shape: (v: number) => T): T | Record<string, never> {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? shape(raw) : {};
}

function stringifyContent(content: unknown): string | undefined {
  if (content == null) return undefined;
  if (typeof content === "string") return content;
  // Claude sometimes sends tool_result content as an array of blocks.
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : String(c)))
      .join("");
  }
  return JSON.stringify(content);
}
