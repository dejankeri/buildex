import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJudgePrompt, parseVerdict, judgeCase, JUDGE_RUBRIC } from "./judge-step.js";
import type { AgentDriver, RunPromptOpts, UiEvent } from "../agent/types.js";
import type { ProofCase } from "./scenario-step.js";

const CASE: ProofCase = {
  id: "find-a-record",
  title: "Find a record",
  kind: "happy",
  prompt: "Find the record for widget-42.",
  expected: "The agent reports the record's status.",
  disqualifiers: ["Agent invents a record id"],
};

const TRANSCRIPT_JSON = JSON.stringify(
  [
    { kind: "text", text: "Looking up widget-42...", at: "2026-07-23T10:00:00.000Z" },
    { kind: "tool", id: "t1", name: "recall", input: {}, at: "2026-07-23T10:00:01.000Z" },
    { kind: "tool_result", id: "t1", name: "recall", ok: true, output: "widget-42: active", at: "2026-07-23T10:00:02.000Z" },
    { kind: "text", text: "widget-42 is active.", at: "2026-07-23T10:00:03.000Z" },
    { kind: "done", at: "2026-07-23T10:00:04.000Z" },
  ],
  null,
  2,
);

const VALID_VERDICT = {
  caseId: "find-a-record",
  band: "strong",
  reasoning: "The agent found widget-42 and reported it active, matching the expected result with no disqualifier tripped.",
  evidence: [2, 3],
  findings: [{ bucket: "strengths", note: "Clean single-tool lookup with no detours." }],
};

function fenced(obj: unknown): string {
  return "Here is my verdict:\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n";
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The house fake-driver idiom (see scenario-step.test.ts / drive-step.test.ts): a tiny async
// generator over a fixed UiEvent array, with `seen` capturing the opts the driver was invoked with.
function fakeDriver(scriptedTexts: string[]): { driver: AgentDriver; seen: RunPromptOpts[] } {
  const seen: RunPromptOpts[] = [];
  let call = 0;
  const driver = {
    detect: async () => ({ available: true }),
    // eslint-disable-next-line @typescript-eslint/require-await
    runPrompt: async function* (o: RunPromptOpts) {
      seen.push(o);
      const text = scriptedTexts[call] ?? scriptedTexts[scriptedTexts.length - 1]!;
      call++;
      yield { kind: "text", text } as unknown as UiEvent;
      yield { kind: "done" } as unknown as UiEvent;
    },
  } as unknown as AgentDriver;
  return { driver, seen };
}

describe("buildJudgePrompt", () => {
  // Contract change (Windows argv limit fix): buildJudgePrompt no longer embeds the transcript body -
  // it takes a transcriptRef (a path, e.g. "./transcript.json") and instructs the judge to Read it.
  it("embeds the rubric verbatim, the full case spec, a pointer to the on-disk transcript, and the output contract - but NEVER the transcript body", () => {
    const prompt = buildJudgePrompt(CASE, "./transcript.json");
    expect(prompt).toContain(JUDGE_RUBRIC);
    expect(prompt).toContain(CASE.id);
    expect(prompt).toContain(CASE.title);
    expect(prompt).toContain(CASE.prompt);
    expect(prompt).toContain(CASE.expected);
    expect(prompt).toContain(CASE.disqualifiers[0]);
    expect(prompt).toContain("./transcript.json");
    expect(prompt).toMatch(/use the read tool/i);
    expect(prompt).not.toContain(TRANSCRIPT_JSON);
    expect(prompt).toMatch(/```json/);
    expect(prompt).toMatch(/strong.*pass.*fail/is);
    expect(prompt).toMatch(/findings/i);
  });

  it("carries the unsatisfiable-premise fairness clause: a correctly-handled non-existent entity is not a fail", () => {
    // Guards RC-A's judge-side safety net: without this guidance the judge fails a case whenever the
    // expected deliverable never appears - even when the prompt named a client/template that simply
    // does not exist and the agent searched, found nothing, and honestly reported it (no fabrication).
    const prompt = buildJudgePrompt(CASE, "./transcript.json");
    expect(prompt).toMatch(/unsatisfiable premise/i);
    expect(prompt).toMatch(/does NOT actually exist|does not exist/i);
    expect(prompt).toMatch(/without fabricating/i);
    expect(prompt).toMatch(/score it\s+"pass"/i);
  });
});

describe("parseVerdict", () => {
  it("parses a valid fenced verdict, findings included", () => {
    const v = parseVerdict(fenced(VALID_VERDICT), "find-a-record");
    expect(v).toEqual(VALID_VERDICT);
  });

  it("parses a valid verdict with an empty findings array", () => {
    const noFindings = { ...VALID_VERDICT, findings: [] };
    const v = parseVerdict(fenced(noFindings), "find-a-record");
    expect(v.findings).toEqual([]);
  });

  it("parses a bare JSON object when no fence is present", () => {
    const text = "Sure: " + JSON.stringify(VALID_VERDICT) + " -- done.";
    const v = parseVerdict(text, "find-a-record");
    expect(v).toEqual(VALID_VERDICT);
  });

  it("uses the LAST fenced json block when several are present", () => {
    const badBlock = "```json\n" + JSON.stringify({ ...VALID_VERDICT, band: "weird" }) + "\n```\n";
    const text = badBlock + "\n\nActually, final answer:\n" + fenced(VALID_VERDICT);
    const v = parseVerdict(text, "find-a-record");
    expect(v).toEqual(VALID_VERDICT);
  });

  it("parses an UNFENCED valid verdict whose reasoning quotes a transcript fragment containing a brace, and whose note contains a brace", () => {
    // Realistic judge prose: quoting a raw transcript event (itself JSON-shaped) inside "reasoning".
    // A brace-counting fallback scanner that isn't string-aware would truncate the slice right at
    // this embedded "}", long before the object's real closing brace.
    const verdict = {
      ...VALID_VERDICT,
      reasoning:
        'The transcript shows the event read: "kind: tool_result, ok: true }" confirming the tool succeeded.',
      findings: [{ bucket: "strengths", note: "Event shape was { as expected } with no surprises." }],
    };
    const text = "Here is my verdict, unfenced: " + JSON.stringify(verdict) + " -- that is all.";
    const v = parseVerdict(text, "find-a-record");
    expect(v).toEqual(verdict);
  });

  it("treats a backslash-escaped quote inside a string as NOT closing the string, so a later brace inside it is skipped correctly", () => {
    // Hand-built raw text (not JSON.stringify) so the escape sequence is explicit and unambiguous:
    // \" appears twice (an escaped quote pair) BEFORE the string's real closing quote, and a stray
    // "}" sits between them and that real closing quote - exactly the shape the fix must handle.
    const text = [
      "Some preamble before the object.",
      "{",
      '  "caseId": "find-a-record",',
      '  "band": "strong",',
      '  "reasoning": "The agent said \\"stop\\" then the transcript read: ok: true }",',
      '  "evidence": [2, 3],',
      '  "findings": [{"bucket": "strengths", "note": "fine"}]',
      "}",
    ].join("\n");
    const v = parseVerdict(text, "find-a-record");
    expect(v.reasoning).toBe('The agent said "stop" then the transcript read: ok: true }');
    expect(v.band).toBe("strong");
  });

  it("rejects an unknown band, naming it", () => {
    const bad = { ...VALID_VERDICT, band: "excellent" };
    expect(() => parseVerdict(fenced(bad), "find-a-record")).toThrow(/band/i);
  });

  it("rejects an unknown finding bucket, naming it", () => {
    const bad = { ...VALID_VERDICT, findings: [{ bucket: "vibes", note: "n/a" }] };
    expect(() => parseVerdict(fenced(bad), "find-a-record")).toThrow(/bucket/i);
  });

  it("rejects a finding with an empty note, naming it", () => {
    const bad = { ...VALID_VERDICT, findings: [{ bucket: "functional", note: "" }] };
    expect(() => parseVerdict(fenced(bad), "find-a-record")).toThrow(/note/i);
  });

  it("rejects missing evidence (not an array), naming it", () => {
    const bad = { ...VALID_VERDICT, evidence: "2, 3" };
    expect(() => parseVerdict(fenced(bad), "find-a-record")).toThrow(/evidence/i);
  });

  it("rejects evidence containing a negative or non-integer index, naming it", () => {
    const bad = { ...VALID_VERDICT, evidence: [1, -1] };
    expect(() => parseVerdict(fenced(bad), "find-a-record")).toThrow(/evidence/i);
  });

  it("rejects a caseId mismatch, naming it", () => {
    expect(() => parseVerdict(fenced(VALID_VERDICT), "some-other-case")).toThrow(/caseId/i);
  });

  it("rejects an empty reasoning field, naming it", () => {
    const bad = { ...VALID_VERDICT, reasoning: "" };
    expect(() => parseVerdict(fenced(bad), "find-a-record")).toThrow(/reasoning/i);
  });

  it('rejects a "strong" band with empty evidence, naming it', () => {
    const bad = { ...VALID_VERDICT, band: "strong", evidence: [] };
    expect(() => parseVerdict(fenced(bad), "find-a-record")).toThrow(/strong/i);
  });

  it('allows a "fail" band with empty evidence', () => {
    const ok = { ...VALID_VERDICT, band: "fail", evidence: [], reasoning: "Expected result was not met." };
    const v = parseVerdict(fenced(ok), "find-a-record");
    expect(v.band).toBe("fail");
    expect(v.evidence).toEqual([]);
  });

  it("rejects when no JSON is found at all, naming it", () => {
    expect(() => parseVerdict("I refuse to judge today.", "find-a-record")).toThrow(/no json/i);
  });

  it("lists every violation in a single thrown error, not just the first", () => {
    const bad = { ...VALID_VERDICT, band: "weird", findings: [{ bucket: "weird-bucket", note: "" }] };
    try {
      parseVerdict(fenced(bad), "find-a-record");
      expect.fail("expected parseVerdict to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/band/i);
      expect(msg).toMatch(/bucket/i);
      expect(msg).toMatch(/note/i);
    }
  });
});

describe("judgeCase", () => {
  function transcriptFixture(): { runDir: string; transcriptPath: string } {
    const runDir = mkdtempSync(join(tmpdir(), "judge-"));
    dirs.push(runDir);
    const transcriptPath = join(runDir, `${CASE.id}.json`);
    writeFileSync(transcriptPath, TRANSCRIPT_JSON);
    return { runDir, transcriptPath };
  }

  it("reads the transcript, copies it into scratchDir/transcript.json, spawns the driver in scratchDir with allowedTools exactly [\"Read\"] (the minimal grant a headless, never-trusted session needs to read the on-disk transcript - the Windows argv limit forced the transcript off the command line), and returns the parsed verdict", async () => {
    const { transcriptPath } = transcriptFixture();
    const scratchDir = mkdtempSync(join(tmpdir(), "judge-scratch-"));
    dirs.push(scratchDir);
    const { driver, seen } = fakeDriver([fenced(VALID_VERDICT)]);

    const verdict = await judgeCase(driver, { scratchDir, case: CASE, transcriptPath, redact: [] });

    expect(verdict).toEqual(VALID_VERDICT);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.workspace).toBe(scratchDir);
    expect(seen[0]!.allowedTools).toEqual(["Read"]);
    expect(seen[0]!.prompt).toContain("./transcript.json");
    expect(seen[0]!.prompt).not.toContain(TRANSCRIPT_JSON);
    expect(readFileSync(join(scratchDir, "transcript.json"), "utf8")).toBe(TRANSCRIPT_JSON);
  });

  it("isolates the judge with strict-mcp: writes an empty .mcp.json in its clean room and points the spawn at it, so the operator's claude.ai connectors are never in reach", async () => {
    const { transcriptPath } = transcriptFixture();
    const scratchDir = mkdtempSync(join(tmpdir(), "judge-scratch-"));
    dirs.push(scratchDir);
    const { driver, seen } = fakeDriver([fenced(VALID_VERDICT)]);

    await judgeCase(driver, { scratchDir, case: CASE, transcriptPath, redact: [] });

    const mcpPath = join(scratchDir, "empty.mcp.json");
    expect(seen[0]!.mcpConfigPath).toBe(mcpPath);
    expect(JSON.parse(readFileSync(mcpPath, "utf8"))).toEqual({ mcpServers: {} });
    // The judge's clean room still holds NO .mcp.json (no pinned credential) - the strict config is a
    // dedicated, credential-free file.
    expect(existsSync(join(scratchDir, ".mcp.json"))).toBe(false);
  });

  it("keeps the judge's prompt SHORT even when the transcript fixture is large (Windows argv limit: the transcript rides on disk, never in the prompt)", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "judge-"));
    dirs.push(runDir);
    const bigTranscript = JSON.stringify(
      [{ kind: "text", text: "x".repeat(150_000), at: "2026-07-23T10:00:00.000Z" }],
      null,
      2,
    );
    expect(bigTranscript.length).toBeGreaterThan(100_000);
    const transcriptPath = join(runDir, `${CASE.id}.json`);
    writeFileSync(transcriptPath, bigTranscript);

    const scratchDir = mkdtempSync(join(tmpdir(), "judge-scratch-"));
    dirs.push(scratchDir);
    const { driver, seen } = fakeDriver([fenced(VALID_VERDICT)]);

    await judgeCase(driver, { scratchDir, case: CASE, transcriptPath, redact: [] });

    expect(readFileSync(join(scratchDir, "transcript.json"), "utf8")).toBe(bigTranscript);
    expect(seen[0]!.prompt.length).toBeLessThan(4000);
  });

  it("retries ONCE, quoting the validation error, and succeeds on the second attempt", async () => {
    const { transcriptPath } = transcriptFixture();
    const scratchDir = mkdtempSync(join(tmpdir(), "judge-scratch-"));
    dirs.push(scratchDir);
    const { driver, seen } = fakeDriver(["garbage, not json at all", fenced(VALID_VERDICT)]);

    const verdict = await judgeCase(driver, { scratchDir, case: CASE, transcriptPath, redact: [] });

    expect(verdict).toEqual(VALID_VERDICT);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.prompt).toContain(seen[0]!.prompt);
    expect(seen[1]!.prompt).toMatch(/previous attempt failed validation/i);
    expect(seen[1]!.prompt).toMatch(/no json/i);
  });

  it("gives up after a second garbage attempt, throwing the validation error", async () => {
    const { transcriptPath } = transcriptFixture();
    const scratchDir = mkdtempSync(join(tmpdir(), "judge-scratch-"));
    dirs.push(scratchDir);
    const { driver, seen } = fakeDriver(["still garbage", "still garbage again"]);

    await expect(judgeCase(driver, { scratchDir, case: CASE, transcriptPath, redact: [] })).rejects.toThrow(/no json/i);
    expect(seen).toHaveLength(2);
  });

  it("treats an error event as a failed attempt and retries", async () => {
    const { transcriptPath } = transcriptFixture();
    const scratchDir = mkdtempSync(join(tmpdir(), "judge-scratch-"));
    dirs.push(scratchDir);
    let call = 0;
    const seen: RunPromptOpts[] = [];
    const driver = {
      detect: async () => ({ available: true }),
      // eslint-disable-next-line @typescript-eslint/require-await
      runPrompt: async function* (o: RunPromptOpts) {
        seen.push(o);
        if (call === 0) {
          call++;
          yield { kind: "error", message: "judge agent crashed" } as unknown as UiEvent;
          return;
        }
        yield { kind: "text", text: fenced(VALID_VERDICT) } as unknown as UiEvent;
        yield { kind: "done" } as unknown as UiEvent;
      },
    } as unknown as AgentDriver;

    const verdict = await judgeCase(driver, { scratchDir, case: CASE, transcriptPath, redact: [] });
    expect(verdict).toEqual(VALID_VERDICT);
    expect(seen).toHaveLength(2);
  });

  it("treats zero text events as a failure and retries", async () => {
    const { transcriptPath } = transcriptFixture();
    const scratchDir = mkdtempSync(join(tmpdir(), "judge-scratch-"));
    dirs.push(scratchDir);
    let call = 0;
    const seen: RunPromptOpts[] = [];
    const driver = {
      detect: async () => ({ available: true }),
      // eslint-disable-next-line @typescript-eslint/require-await
      runPrompt: async function* (o: RunPromptOpts) {
        seen.push(o);
        if (call === 0) {
          call++;
          yield { kind: "done" } as unknown as UiEvent;
          return;
        }
        yield { kind: "text", text: fenced(VALID_VERDICT) } as unknown as UiEvent;
        yield { kind: "done" } as unknown as UiEvent;
      },
    } as unknown as AgentDriver;

    const verdict = await judgeCase(driver, { scratchDir, case: CASE, transcriptPath, redact: [] });
    expect(verdict).toEqual(VALID_VERDICT);
    expect(seen).toHaveLength(2);
  });

  it("redacts the secret embedded in the FIRST attempt's validation error before it rides the retry prompt", async () => {
    const { transcriptPath } = transcriptFixture();
    const scratchDir = mkdtempSync(join(tmpdir(), "judge-scratch-"));
    dirs.push(scratchDir);
    // Bracket-balanced but invalid JSON: JSON.parse's own SyntaxError message quotes the raw input
    // verbatim, so the secret leaks into firstMessage unless it is redacted before being
    // interpolated into the retry prompt (which becomes the SECOND spawn's actual prompt).
    const { driver, seen } = fakeDriver(['{"a": sekret2}', fenced(VALID_VERDICT)]);

    const verdict = await judgeCase(driver, { scratchDir, case: CASE, transcriptPath, redact: ["sekret2"] });

    expect(verdict).toEqual(VALID_VERDICT);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.prompt).toContain("[REDACTED]");
    expect(seen[1]!.prompt).not.toContain("sekret2");
  });

  it("redacts secret values from any error it throws", async () => {
    const { transcriptPath } = transcriptFixture();
    const scratchDir = mkdtempSync(join(tmpdir(), "judge-scratch-"));
    dirs.push(scratchDir);
    // Bracket-balanced but invalid JSON (a bare identifier as an object value) short enough that
    // V8's JSON.parse error embeds it in full, uncropped - proving redaction actually did something.
    const { driver } = fakeDriver(['{"a": sekret1}', '{"a": sekret1}']);

    try {
      await judgeCase(driver, { scratchDir, case: CASE, transcriptPath, redact: ["sekret1"] });
      expect.fail("expected judgeCase to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("[REDACTED]");
      expect(msg).not.toContain("sekret1");
    }
  });
});
