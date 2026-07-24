import { describe, it, expect } from "vitest";
import { buildGeneratorPrompt, parseCases, generateCases } from "./scenario-step.js";
import type { AgentDriver, RunPromptOpts, UiEvent } from "../agent/types.js";
import type { Surface } from "./discover.js";

const SURFACE: Surface = {
  pack: "acme",
  skills: [{ name: "acme-howto", description: "How to use Acme" }],
  tools: [{ name: "acme_search", description: "Search Acme records" }],
};

const VALID_CASES = [
  {
    id: "find-a-record",
    title: "Find a record",
    kind: "happy",
    prompt: "Find the record for widget-42.",
    expected: "The agent reports the record's status.",
    disqualifiers: ["Agent invents a record id"],
  },
  {
    id: "search-with-no-results",
    title: "Search with no results",
    kind: "edge",
    prompt: "Search for a record that does not exist.",
    expected: "The agent reports no results found.",
    disqualifiers: ["Agent fabricates a result", "Agent crashes"],
  },
];

function fenced(cases: unknown): string {
  return "Here are the cases:\n```json\n" + JSON.stringify(cases, null, 2) + "\n```\n";
}

// The house fake-driver idiom (see drive-step.test.ts / run.test.ts): a tiny async generator over
// a fixed UiEvent array, with `seen` capturing the opts the driver was actually invoked with.
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

describe("buildGeneratorPrompt", () => {
  it("embeds the surface JSON and asks for exactly n cases with the required shape", () => {
    const prompt = buildGeneratorPrompt(SURFACE, 3);
    expect(prompt).toContain(JSON.stringify(SURFACE, null, 2));
    expect(prompt).toMatch(/exactly 3/i);
    expect(prompt).toMatch(/kebab-case/i);
    expect(prompt).toMatch(/happy/);
    expect(prompt).toMatch(/edge/);
    expect(prompt).toMatch(/```json/);
    expect(prompt).toMatch(/disqualifiers/i);
    expect(prompt).toMatch(/day-in-the-life/i);
  });
});

describe("parseCases", () => {
  it("parses a valid fenced json block", () => {
    const cases = parseCases(fenced(VALID_CASES), 2);
    expect(cases).toEqual(VALID_CASES);
  });

  it("parses a bare JSON array when no fence is present", () => {
    const text = "Sure, here you go: " + JSON.stringify(VALID_CASES) + " -- done.";
    const cases = parseCases(text, 2);
    expect(cases).toEqual(VALID_CASES);
  });

  it("uses the LAST fenced json block when several are present", () => {
    const badBlock = "```json\n" + JSON.stringify([{ ...VALID_CASES[0], id: "" }]) + "\n```\n";
    const text = badBlock + "\n\nActually, final answer:\n" + fenced(VALID_CASES);
    const cases = parseCases(text, 2);
    expect(cases).toEqual(VALID_CASES);
  });

  it("parses an UNFENCED valid array whose case prompt quotes a transcript fragment containing bracket/brace characters", () => {
    // A bracket-counting fallback scanner that isn't string-aware would decrement its depth on the
    // lone "]" inside the prompt string and truncate the slice long before the array's real end.
    const cases = [
      {
        ...VALID_CASES[0],
        prompt:
          'Ask the agent to summarize a transcript that read: "results] truncated early" and shape { ok: true }.',
      },
      VALID_CASES[1],
    ];
    const text = "Here you go, unfenced: " + JSON.stringify(cases) + " -- done.";
    const parsed = parseCases(text, 2);
    expect(parsed).toEqual(cases);
  });

  it("rejects the wrong count, naming it", () => {
    expect(() => parseCases(fenced([VALID_CASES[0]]), 2)).toThrow(/count|length|2/i);
  });

  it("rejects duplicate ids, naming it", () => {
    const dup = [VALID_CASES[0], { ...VALID_CASES[1], id: VALID_CASES[0]!.id }];
    expect(() => parseCases(fenced(dup), 2)).toThrow(/duplicate/i);
  });

  it("rejects a non-kebab-case id, naming it", () => {
    const bad = [{ ...VALID_CASES[0], id: "Find_A_Record" }, VALID_CASES[1]];
    expect(() => parseCases(fenced(bad), 2)).toThrow(/kebab-case/i);
  });

  it("rejects an id longer than 64 characters, naming the length limit", () => {
    const longId = "a" + "b".repeat(64); // 65 chars, otherwise valid kebab-case
    const bad = [{ ...VALID_CASES[0], id: longId }, VALID_CASES[1]];
    expect(() => parseCases(fenced(bad), 2)).toThrow(/length|64|characters/i);
  });

  it("rejects an empty expected field, naming it", () => {
    const bad = [{ ...VALID_CASES[0], expected: "" }, VALID_CASES[1]];
    expect(() => parseCases(fenced(bad), 2)).toThrow(/expected/i);
  });

  it("rejects zero edge cases, naming it", () => {
    const noEdge = [VALID_CASES[0], { ...VALID_CASES[1], kind: "happy" }];
    expect(() => parseCases(fenced(noEdge), 2)).toThrow(/edge/i);
  });

  it("reports both count mismatch AND missing edge case in one error", () => {
    const noEdge = [VALID_CASES[0]]; // only 1 case, expected 2, and it's happy (no edge)
    try {
      parseCases(fenced(noEdge), 2);
      expect.fail("expected parseCases to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/count|length|mismatch/i);
      expect(msg).toMatch(/edge/i);
    }
  });

  it("rejects a kind outside happy/edge, naming it", () => {
    const bad = [VALID_CASES[0], { ...VALID_CASES[1], kind: "weird" }];
    expect(() => parseCases(fenced(bad), 2)).toThrow(/kind/i);
  });

  it("rejects disqualifiers outside the 1-3 length band, naming it", () => {
    const bad = [VALID_CASES[0], { ...VALID_CASES[1], disqualifiers: [] }];
    expect(() => parseCases(fenced(bad), 2)).toThrow(/disqualifier/i);
  });

  it("rejects when no JSON is found at all, naming it", () => {
    expect(() => parseCases("I refuse to produce cases today.", 2)).toThrow(/no json/i);
  });

  it("lists every violation in a single thrown error, not just the first", () => {
    const bad = [
      { ...VALID_CASES[0], id: "Bad Id", expected: "" },
      { ...VALID_CASES[1], kind: "happy" },
    ];
    try {
      parseCases(fenced(bad), 2);
      expect.fail("expected parseCases to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/kebab-case/i);
      expect(msg).toMatch(/expected/i);
      expect(msg).toMatch(/edge/i);
    }
  });
});

describe("generateCases", () => {
  it("runs the driver with no allowedTools and returns the parsed cases on the first attempt", async () => {
    const { driver, seen } = fakeDriver([fenced(VALID_CASES)]);
    const cases = await generateCases(driver, { workspace: "w", surface: SURFACE, n: 2, redact: [] });
    expect(cases).toEqual(VALID_CASES);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.allowedTools).toBeUndefined();
    expect(seen[0]!.workspace).toBe("w");
  });

  it("forwards mcpConfigPath to the spawn (strict-mcp isolation), and omits it when not given", async () => {
    const { driver: d1, seen: s1 } = fakeDriver([fenced(VALID_CASES)]);
    await generateCases(d1, { workspace: "w", surface: SURFACE, n: 2, redact: [], mcpConfigPath: "w/.mcp.json" });
    expect(s1[0]!.mcpConfigPath).toBe("w/.mcp.json");

    const { driver: d2, seen: s2 } = fakeDriver([fenced(VALID_CASES)]);
    await generateCases(d2, { workspace: "w", surface: SURFACE, n: 2, redact: [] });
    expect(s2[0]!.mcpConfigPath).toBeUndefined();
  });

  it("retries ONCE, quoting the parse error, and succeeds on the second attempt", async () => {
    const { driver, seen } = fakeDriver(["garbage, not json at all", fenced(VALID_CASES)]);
    const cases = await generateCases(driver, { workspace: "w", surface: SURFACE, n: 2, redact: [] });
    expect(cases).toEqual(VALID_CASES);
    expect(seen).toHaveLength(2);
    // second prompt carries the first prompt forward plus the quoted failure
    expect(seen[1]!.prompt).toContain(seen[0]!.prompt);
    expect(seen[1]!.prompt).toMatch(/previous attempt failed validation/i);
    expect(seen[1]!.prompt).toMatch(/no json/i);
  });

  it("gives up after a second garbage attempt, throwing the parse error", async () => {
    const { driver, seen } = fakeDriver(["still garbage", "still garbage again"]);
    await expect(generateCases(driver, { workspace: "w", surface: SURFACE, n: 2, redact: [] })).rejects.toThrow(/no json/i);
    expect(seen).toHaveLength(2);
  });

  it("treats an error event as a failed attempt and retries", async () => {
    let call = 0;
    const seen: RunPromptOpts[] = [];
    const driver = {
      detect: async () => ({ available: true }),
      // eslint-disable-next-line @typescript-eslint/require-await
      runPrompt: async function* (o: RunPromptOpts) {
        seen.push(o);
        if (call === 0) {
          call++;
          yield { kind: "error", message: "agent crashed" } as unknown as UiEvent;
          return;
        }
        yield { kind: "text", text: fenced(VALID_CASES) } as unknown as UiEvent;
        yield { kind: "done" } as unknown as UiEvent;
      },
    } as unknown as AgentDriver;
    const cases = await generateCases(driver, { workspace: "w", surface: SURFACE, n: 2, redact: [] });
    expect(cases).toEqual(VALID_CASES);
    expect(seen).toHaveLength(2);
  });

  it("redacts secret values from any error it throws", async () => {
    // Use bracket-balanced but invalid JSON that embeds the secret as a bare identifier.
    // JSON.parse's error will include the raw input, exposing the secret before redaction.
    const { driver } = fakeDriver(["[pk_super_secret_1]", "[pk_super_secret_1]"]);
    await expect(
      generateCases(driver, { workspace: "w", surface: SURFACE, n: 2, redact: ["pk_super_secret_1"] }),
    ).rejects.toThrow();
    try {
      await generateCases(driver, { workspace: "w", surface: SURFACE, n: 2, redact: ["pk_super_secret_1"] });
      expect.fail("expected generateCases to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("[REDACTED]");
      expect(msg).not.toContain("pk_super_secret_1");
    }
  });

  it("redacts the secret embedded in the FIRST attempt's validation error before it rides the retry prompt", async () => {
    // Bracket-balanced but invalid JSON: JSON.parse's own SyntaxError message quotes the raw input
    // verbatim (Node embeds a snippet of the offending text), so the secret leaks into firstMessage
    // unless it is redacted before being interpolated into the retry prompt.
    const { driver, seen } = fakeDriver(["[pk_retry_secret_1]", fenced(VALID_CASES)]);
    const cases = await generateCases(driver, { workspace: "w", surface: SURFACE, n: 2, redact: ["pk_retry_secret_1"] });
    expect(cases).toEqual(VALID_CASES);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.prompt).toContain("[REDACTED]");
    expect(seen[1]!.prompt).not.toContain("pk_retry_secret_1");
  });

  it("treats zero text events as a failure and retries", async () => {
    let call = 0;
    const seen: RunPromptOpts[] = [];
    const driver = {
      detect: async () => ({ available: true }),
      // eslint-disable-next-line @typescript-eslint/require-await
      runPrompt: async function* (o: RunPromptOpts) {
        seen.push(o);
        if (call === 0) {
          call++;
          yield { kind: "done" } as unknown as UiEvent; // no text at all
          return;
        }
        yield { kind: "text", text: fenced(VALID_CASES) } as unknown as UiEvent;
        yield { kind: "done" } as unknown as UiEvent;
      },
    } as unknown as AgentDriver;
    const cases = await generateCases(driver, { workspace: "w", surface: SURFACE, n: 2, redact: [] });
    expect(cases).toEqual(VALID_CASES);
    expect(seen).toHaveLength(2);
  });
});
