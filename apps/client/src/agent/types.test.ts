import { describe, it, expect } from "vitest";
import { isTerminal, type UiEvent } from "./types.js";

describe("isTerminal", () => {
  it("is true for done and error events (a turn has ended)", () => {
    expect(isTerminal({ kind: "done" })).toBe(true);
    expect(isTerminal({ kind: "error", message: "boom" })).toBe(true);
  });

  it("is false for streaming events", () => {
    const streaming: UiEvent[] = [
      { kind: "text", text: "hi" },
      { kind: "thinking", text: "hmm" },
      { kind: "tool", id: "t1", name: "Edit", input: {} },
      { kind: "tool_result", id: "t1", name: "Edit", ok: true },
    ];
    for (const e of streaming) expect(isTerminal(e)).toBe(false);
  });
});
