import { describe, it, expect } from "vitest";
import { ClaudeStreamParser } from "./parser.js";
import type { UiEvent } from "./types.js";

const WS = "/ws";
function drain(lines: string[]): UiEvent[] {
  const p = new ClaudeStreamParser({ workspace: WS });
  const out: UiEvent[] = [];
  for (const l of lines) out.push(...p.push(l + "\n"));
  out.push(...p.end());
  return out;
}

const initLine = JSON.stringify({ type: "system", subtype: "init", session_id: "s1", tools: ["Edit"] });
const textLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] }, session_id: "s1" });
const thinkLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "let me think" }] } });
const toolLine = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "tu_1", name: "Edit", input: { file_path: "/ws/team-acme/notes.md", old_string: "a", new_string: "b" } }] },
  session_id: "s1",
});
const resultLine = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }] } });
const doneLine = JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "s1" });

describe("ClaudeStreamParser", () => {
  it("emits a text event from an assistant text block", () => {
    const events = drain([textLine]);
    expect(events).toContainEqual({ kind: "text", text: "Hello" });
  });

  it("emits a thinking event", () => {
    expect(drain([thinkLine])).toContainEqual({ kind: "thinking", text: "let me think" });
  });

  it("emits a tool event with the file path normalized to workspace-relative", () => {
    const events = drain([toolLine]);
    const tool = events.find((e) => e.kind === "tool");
    expect(tool).toMatchObject({ kind: "tool", id: "tu_1", name: "Edit", path: "team-acme/notes.md" });
  });

  it("labels a tool_result with the tool name from the retained id→name map", () => {
    const events = drain([toolLine, resultLine]);
    expect(events).toContainEqual({ kind: "tool_result", id: "tu_1", name: "Edit", ok: true, output: "ok" });
  });

  it("marks a tool_result with is_error:true as not ok", () => {
    const errResult = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "boom", is_error: true }] } });
    const events = drain([toolLine, errResult]);
    expect(events).toContainEqual({ kind: "tool_result", id: "tu_1", name: "Edit", ok: false, output: "boom" });
  });

  it("emits done with the session id captured from init", () => {
    const events = drain([initLine, textLine, doneLine]);
    expect(events.at(-1)).toEqual({ kind: "done", sessionId: "s1" });
  });

  // The result line is the ONLY place the agent prices its own work. Dropping it (as this parser
  // used to) is what made a loop's spend unknowable and a spending limit unenforceable.
  it("carries the cost and duration the agent reported for the turn", () => {
    const priced = JSON.stringify({ type: "result", subtype: "success", session_id: "s1", total_cost_usd: 0.0412, duration_ms: 8321 });
    expect(drain([initLine, priced]).at(-1)).toEqual({ kind: "done", sessionId: "s1", costUsd: 0.0412, ms: 8321 });
  });

  it("omits a price the agent did not report rather than inventing a zero", () => {
    expect(drain([initLine, doneLine]).at(-1)).toEqual({ kind: "done", sessionId: "s1" });
  });

  it("ignores a cost that is not a usable number, so no limit is measured on junk", () => {
    for (const bad of ['"0.04"', "null", "-1", "1e999"]) {
      const line = `{"type":"result","subtype":"success","session_id":"s1","total_cost_usd":${bad}}`;
      expect(drain([line]).at(-1)).toEqual({ kind: "done", sessionId: "s1" });
    }
  });

  it("reassembles a frame split across two push() calls", () => {
    const p = new ClaudeStreamParser({ workspace: WS });
    const out: UiEvent[] = [];
    out.push(...p.push('{"type":"assistant","message":{"content":[{"type":"text",'));
    out.push(...p.push('"text":"hi"}]}}\n'));
    expect(out).toContainEqual({ kind: "text", text: "hi" });
  });

  it("is tolerant of an unparseable line - emits an error event, does not throw", () => {
    const events = drain(["{not json"]);
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  it("does not normalize a path that is outside the workspace (leaves it absolute)", () => {
    const outside = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/etc/passwd" } }] } });
    const tool = drain([outside]).find((e) => e.kind === "tool");
    expect(tool).toMatchObject({ path: "/etc/passwd" });
  });
});
