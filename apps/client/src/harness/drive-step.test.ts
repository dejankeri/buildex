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
  it("threads allowedTools through to the driver's runPrompt", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "drive-"));
    dirs.push(runDir);
    let seen: string[] | undefined;
    const driver = {
      detect: async () => ({ ok: true }) as never,
      // eslint-disable-next-line @typescript-eslint/require-await
      runPrompt: async function* (o: { allowedTools?: string[] }) {
        seen = o.allowedTools;
        yield { kind: "done" } as UiEvent;
      } as never,
    } as AgentDriver;
    await driveCase(driver, { workspace: "w", prompt: "p", runDir, caseId: "c", allowedTools: ["mcp__buildex-pack_acme"] });
    expect(seen).toEqual(["mcp__buildex-pack_acme"]);
  });

  it("marks a TRUNCATED stream as errored - a stream with no done and no error is a crashed agent, not a pass", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "drive-"));
    dirs.push(runDir);
    const events = [{ kind: "text", text: "working..." }] as unknown as UiEvent[]; // no done, no error
    const r = await driveCase(fakeDriver(events), { workspace: "w", prompt: "p", runDir, caseId: "trunc" });
    expect(r.errored).toBe(true);
  });

  it("survives a driver iterator that THROWS mid-stream: no rejection, errored=true, transcript still written with the events captured so far", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "drive-"));
    dirs.push(runDir);
    const driver = {
      detect: async () => ({ ok: true }) as never,
      // eslint-disable-next-line @typescript-eslint/require-await
      runPrompt: async function* () {
        yield { kind: "text", text: "one" } as UiEvent;
        yield { kind: "tool", id: "t1", name: "recall", input: {} } as unknown as UiEvent;
        throw new Error("stream snapped");
      } as never,
    } as AgentDriver;
    const r = await driveCase(driver, { workspace: "w", prompt: "p", runDir, caseId: "snap" });
    expect(r.errored).toBe(true);
    expect(r.toolCalls).toBe(1);
    const transcript = JSON.parse(readFileSync(join(runDir, "transcripts", "snap.json"), "utf8"));
    expect(transcript.some((e: { kind: string; text?: string }) => e.kind === "text" && e.text === "one")).toBe(true);
    expect(transcript.some((e: { kind: string; message?: string }) => e.kind === "error" && /stream snapped/.test(e.message ?? ""))).toBe(true);
  });

  it("redacts given secret values from the PERSISTED transcript (the surviving artifact), not from counting", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "drive-"));
    dirs.push(runDir);
    const events = [
      { kind: "text", text: "the header is Bearer pk_super_secret_123 ok" },
      { kind: "tool_result", id: "t1", name: "Read", ok: true, output: "url: x, key=pk_super_secret_123" },
      { kind: "done" },
    ] as unknown as UiEvent[];
    const r = await driveCase(fakeDriver(events), { workspace: "w", prompt: "p", runDir, caseId: "red", redact: ["pk_super_secret_123"] });
    const raw = readFileSync(r.transcriptPath, "utf8");
    expect(raw).not.toContain("pk_super_secret_123");
    expect(raw).toContain("[REDACTED]");
    expect(r.errored).toBe(false);
  });

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
