import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveCase } from "./drive-step.js";
import type { AgentDriver, UiEvent } from "../agent/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeDriver(events: UiEvent[]): AgentDriver {
  return {
    detect: async () => ({ ok: true }) as never,
    // eslint-disable-next-line @typescript-eslint/require-await
    runPrompt: async function* () {
      for (const e of events) yield e;
    } as never,
  } as AgentDriver;
}

describe("driveCase", () => {
  it("captures stamped events to the transcript and counts tool calls", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "drive-"));
    dirs.push(runDir);
    const events = [
      { kind: "text", text: "hi" },
      { kind: "tool", id: "t1", name: "recall", input: {} },
      { kind: "tool_result", id: "t1", name: "recall", ok: true },
      { kind: "done" },
    ] as unknown as UiEvent[];
    const r = await driveCase(fakeDriver(events), {
      workspace: "w",
      prompt: "p",
      runDir,
      caseId: "case-01",
      now: () => new Date("2026-07-22T10:00:00Z"),
    });
    expect(r.caseId).toBe("case-01");
    expect(r.toolCalls).toBe(1);
    expect(r.toolFailures).toBe(0);
    expect(r.errored).toBe(false);
    const stored = JSON.parse(readFileSync(r.transcriptPath, "utf8"));
    expect(stored).toHaveLength(4);
    expect(stored[0].at).toBe("2026-07-22T10:00:00.000Z");
  });

  it("flags errored when an error event arrives", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "drive-"));
    dirs.push(runDir);
    const r = await driveCase(
      fakeDriver([{ kind: "error", message: "boom" } as unknown as UiEvent]),
      { workspace: "w", prompt: "p", runDir, caseId: "c" }
    );
    expect(r.errored).toBe(true);
  });

  it("counts failed tool calls separately from error events", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "drive-"));
    dirs.push(runDir);
    const events = [
      { kind: "tool", id: "t1", name: "test", input: {} },
      { kind: "tool_result", id: "t1", name: "test", ok: false },
      { kind: "done" },
    ] as unknown as UiEvent[];
    const r = await driveCase(fakeDriver(events), {
      workspace: "w",
      prompt: "p",
      runDir,
      caseId: "case-failed",
    });
    expect(r.toolFailures).toBe(1);
    expect(r.errored).toBe(false);
  });
});
