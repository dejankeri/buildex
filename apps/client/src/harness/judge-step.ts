// The independent judge: a FRESH agent spawn (empty scratch dir, Read-only) scores a driven case
// against its raw persisted transcript. Context isolation is the whole point - the judge never sees
// the workspace, the pack, or any other case; it sees only the case spec and the transcript JSON
// (copied into its own clean room and Read from disk - see judgeCase's doc comment for why).
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentDriver, RunPromptOpts } from "../agent/types.js";
import type { ProofCase } from "./scenario-step.js";
import { redactText } from "./redact.js";

export type Band = "strong" | "pass" | "fail";

export interface Verdict {
  caseId: string;
  band: Band;
  reasoning: string;
  evidence: number[];
  findings: { bucket: "crashes" | "functional" | "non-functional" | "product-ux" | "strengths"; note: string }[];
}

type Bucket = Verdict["findings"][number]["bucket"];

const BANDS: readonly Band[] = ["strong", "pass", "fail"];
const BUCKETS: readonly Bucket[] = ["crashes", "functional", "non-functional", "product-ux", "strengths"];

/** Decision 2's rubric, embedded verbatim in every judge prompt (buildJudgePrompt) so the band
 *  boundaries are never re-worded per case. */
export const JUDGE_RUBRIC = `Score the case into exactly one band:
- "strong": the expected result was met, AND no disqualifier was tripped, AND no tool failure was
  papered over by fabrication.
- "pass": the expected result was met, but with rough edges (retries, detours, partial formatting).
- "fail": the expected result was NOT met, OR any disqualifier was tripped.

You must cite evidence: the 0-based indexes of the transcript events that support your verdict.`;

/** Build the judge's prompt: the rubric, the full case spec (so the judge knows what "expected"
 *  and "disqualifiers" mean for THIS case), a POINTER to the on-disk transcript (never embedded -
 *  a long transcript riding the prompt blows past Windows's ~32K argv limit on `claude -p <prompt>`
 *  and the judge spawn dies with ENAMETOOLONG; see judgeCase, which copies the transcript into the
 *  judge's clean room before this prompt is built), and the exact output contract parseVerdict will
 *  enforce. The judge is told, in-prompt, to Read the transcript itself and score from it alone - it
 *  has no other tools and no workspace content to fall back on regardless. */
export function buildJudgePrompt(c: ProofCase, transcriptRef: string): string {
  const spec = { id: c.id, title: c.title, kind: c.kind, prompt: c.prompt, expected: c.expected, disqualifiers: c.disqualifiers };
  return `You are an independent judge scoring a completed end-to-end test case. You did NOT drive
this case yourself - you are reading its raw transcript after the fact, with no other context.
Judge ONLY from the transcript; never assume anything about the workspace or any other case.

${JUDGE_RUBRIC}

Here is the case under test:

\`\`\`json
${JSON.stringify(spec, null, 2)}
\`\`\`

First use the Read tool to read ${transcriptRef} (the full transcript of the case under judgment - a
JSON array of events, 0-indexed), then judge ONLY from it.

Respond with ONLY a single fenced code block, and nothing else:

\`\`\`json
{
  "caseId": "${c.id}",
  "band": "strong|pass|fail",
  "reasoning": "<2-6 sentences>",
  "evidence": [<transcript event indexes (0-based) supporting your verdict>],
  "findings": [{"bucket": "crashes|functional|non-functional|product-ux|strengths", "note": "..."}]
}
\`\`\`

"findings" may be an empty array. Every finding must name a bucket from the fixed vocabulary above.
`;
}

/** Find the last fenced \`\`\`json ... \`\`\` block in `text`. Falls back to the first `{` … matching
 *  `}` slice when no fence is present. Returns undefined when neither is found. Mirrors
 *  scenario-step's extractJsonBlock (SAME string-aware scan, symmetric implementation - see that
 *  function's doc comment), but matches an OBJECT (verdicts are one object, not an array of cases). */
function extractJsonObject(text: string): string | undefined {
  const fenceRe = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = fenceRe.exec(text))) {
    last = match[1];
  }
  if (last !== undefined) return last;

  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      // Inside a string: a backslash escapes whatever follows it (most importantly a quote), so
      // skip that next character unconditionally rather than ever treating it as a closing quote.
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Extract the last fenced json block (or bare object), parse it, and validate it fail-closed:
 *  caseId matches EXACTLY, band is one of the fixed set, reasoning is a non-empty string, evidence
 *  is an array of non-negative integers (empty is fine, UNLESS band is "strong" - a strong verdict
 *  must cite evidence), and findings is an array (possibly empty) of {bucket, note} where bucket is
 *  from the fixed vocabulary and note is non-empty. On ANY violation throws ONE error listing every
 *  violation found (operator-readable - the retry prompt quotes it verbatim). */
export function parseVerdict(text: string, caseId: string): Verdict {
  const block = extractJsonObject(text);
  if (block === undefined) {
    throw new Error("no json found in the judge's response (no ```json fenced block and no bare JSON object)");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (e) {
    throw new Error(`could not parse the extracted json: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the parsed json is not an object");
  }

  const v = parsed as Record<string, unknown>;
  const violations: string[] = [];

  if (typeof v.caseId !== "string" || v.caseId !== caseId) {
    violations.push(`"caseId" must exactly match ${JSON.stringify(caseId)} (got ${JSON.stringify(v.caseId)})`);
  }

  if (typeof v.band !== "string" || !BANDS.includes(v.band as Band)) {
    violations.push(`"band" must be one of ${BANDS.join("/")} (got ${JSON.stringify(v.band)})`);
  }

  if (!isNonEmptyString(v.reasoning)) {
    violations.push('"reasoning" must be a non-empty string');
  }

  let evidence: number[] = [];
  const evidenceIsValid = Array.isArray(v.evidence) && v.evidence.every(isNonNegativeInt);
  if (!evidenceIsValid) {
    violations.push('"evidence" must be an array of non-negative integers');
  } else {
    evidence = v.evidence as number[];
    if (v.band === "strong" && evidence.length === 0) {
      violations.push('a "strong" band must cite evidence (empty evidence array)');
    }
  }

  let findings: Verdict["findings"] = [];
  if (!Array.isArray(v.findings)) {
    violations.push('"findings" must be an array (possibly empty)');
  } else {
    findings = v.findings.map((raw, i) => {
      const f = raw as Partial<{ bucket: unknown; note: unknown }> | null | undefined;
      const label = `findings[${i}]`;
      if (typeof f?.bucket !== "string" || !BUCKETS.includes(f.bucket as Bucket)) {
        violations.push(`${label}: "bucket" must be one of ${BUCKETS.join("/")} (got ${JSON.stringify(f?.bucket)})`);
      }
      if (!isNonEmptyString(f?.note)) {
        violations.push(`${label}: "note" must be a non-empty string`);
      }
      return { bucket: f?.bucket, note: f?.note } as Verdict["findings"][number];
    });
  }

  if (violations.length > 0) {
    throw new Error(`judge verdict failed validation:\n- ${violations.join("\n- ")}`);
  }

  return {
    caseId: v.caseId as string,
    band: v.band as Band,
    reasoning: v.reasoning as string,
    evidence,
    findings,
  };
}

/** Copy the (already-redacted) persisted transcript into `scratchDir/transcript.json` - the judge
 *  reads it off disk rather than embedding it in the prompt, which would otherwise ride
 *  `claude -p <prompt>`'s argv and blow past Windows's ~32K command-line limit for any sizeable
 *  transcript (spawn ENAMETOOLONG). mkdirSync(scratchDir) is a safety net - proof.ts already creates
 *  it - not a requirement. Then spawn the driver in `scratchDir` with allowedTools: ["Read"] (the
 *  minimal grant a headless, never-trusted clean room needs to read that one file - nothing else)
 *  and collect its text events. An error event or zero text is a failed attempt; retries ONCE with
 *  the original prompt plus the quoted validation error. A second failure throws that error,
 *  redacted. The judge owns no transcript writing (beyond this copy) and no clock. */
export async function judgeCase(
  driver: AgentDriver,
  opts: { scratchDir: string; case: ProofCase; transcriptPath: string; redact: string[] },
): Promise<Verdict> {
  mkdirSync(opts.scratchDir, { recursive: true });
  copyFileSync(opts.transcriptPath, join(opts.scratchDir, "transcript.json"));
  const prompt = buildJudgePrompt(opts.case, "./transcript.json");

  const attempt = async (thisPrompt: string): Promise<Verdict> => {
    let text = "";
    let sawError: string | undefined;
    const runOpts: RunPromptOpts = { prompt: thisPrompt, workspace: opts.scratchDir, allowedTools: ["Read"] };
    for await (const event of driver.runPrompt(runOpts)) {
      if (event.kind === "text") text += (text ? "\n" : "") + event.text;
      if (event.kind === "error") sawError = event.message;
    }
    if (sawError !== undefined) {
      throw new Error(`agent driver reported an error: ${sawError}`);
    }
    if (!text) {
      throw new Error("no json found in the judge's response (no text produced)");
    }
    return parseVerdict(text, opts.case.id);
  };

  try {
    return await attempt(prompt);
  } catch (firstError) {
    const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
    // Redact BEFORE interpolating: the first attempt's raw text can survive inside this message
    // (e.g. JSON.parse's own SyntaxError quotes the offending input verbatim), and this message
    // rides the retry prompt straight into the next agent spawn - an unredacted secret here would
    // leak into that transcript even though the thrown-error path below is already redacted.
    const retryPrompt = `${prompt}\n\nYour previous attempt failed validation: ${redactText(firstMessage, opts.redact)}. Emit ONLY the corrected json block.`;
    try {
      return await attempt(retryPrompt);
    } catch (secondError) {
      const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(redactText(secondMessage, opts.redact));
    }
  }
}
