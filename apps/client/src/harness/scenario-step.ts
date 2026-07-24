// Turns a discovered pack Surface into N day-in-the-life test cases by asking the real agent (via
// the AgentDriver seam, no MCP tools granted) to write them, then validating its JSON output
// fail-closed: every case survives strict shape/content checks or the run refuses. Nothing here
// touches disk, the clock, or persists a transcript - that is drive-step.ts's job one layer up.
import type { AgentDriver, RunPromptOpts } from "../agent/types.js";
import type { Surface } from "./discover.js";
import { redactText } from "./redact.js";

export interface ProofCase {
  id: string;
  title: string;
  kind: "happy" | "edge";
  prompt: string;
  expected: string;
  disqualifiers: string[];
}

const KEBAB_CASE = /^[a-z][a-z0-9-]*$/;
// A case id becomes a directory name (proof.ts's provisionRunContext slug, under
// <runDir>/cases/<id>/); an unbounded id can blow Windows's ~260-char path limit during cpSync
// (install) well before any other component of the path does.
const MAX_ID_LENGTH = 64;

/** Build the generator's prompt: the surface JSON verbatim (so the agent can only ever reference
 *  tools/skills that actually exist) plus the exact output contract parseCases will enforce. */
export function buildGeneratorPrompt(surface: Surface, n: number): string {
  return `You are writing end-to-end test scenarios for a software pack, from the perspective of an
operator's day-in-the-life use of it - real tasks a person would actually ask an assistant to do
with this pack, not synthetic API probes.

Here is the pack's surface (its skills and tools) - the ONLY capabilities you may assume exist.
Never invent a tool or skill name beyond what is listed here.

\`\`\`json
${JSON.stringify(surface, null, 2)}
\`\`\`

Write EXACTLY ${n} test cases. Each case is a JSON object with these fields:
- "id": a unique, kebab-case identifier (lowercase letters, digits, hyphens only, e.g. "find-a-record")
- "title": a short human-readable title
- "kind": either "happy" or "edge" - at least one case MUST be "edge"
- "prompt": the exact day-in-the-life instruction to give the agent under test
- "expected": an observable result a human could check for (not an internal implementation detail)
- "disqualifiers": an array of 1 to 3 short strings describing observable ways the run should be
  judged a failure (e.g. "agent invents a record id", "agent fabricates a result")

Respond with ONLY a single fenced code block, and nothing else:

\`\`\`json
[ ...the ${n} case objects... ]
\`\`\`
`;
}

/** Find the last fenced \`\`\`json ... \`\`\` block in `text`. Falls back to the first `[` … matching
 *  `]` slice when no fence is present (some agents forget to fence a short answer). Returns
 *  undefined when neither is found.
 *
 *  The fallback scan is string-aware: a `"` toggles an in-string flag (unless it is itself
 *  backslash-escaped), and `[`/`]` characters are only counted toward the depth when NOT inside a
 *  string - otherwise a judge/generator quoting a transcript fragment like `"results] early"`
 *  inside a string value would truncate the slice at that embedded bracket. judge-step's
 *  extractJsonObject is the symmetric twin of this scan, matching `{`/`}` instead. */
function extractJsonBlock(text: string): string | undefined {
  const fenceRe = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = fenceRe.exec(text))) {
    last = match[1];
  }
  if (last !== undefined) return last;

  const start = text.indexOf("[");
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
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Extract the last fenced json block (or bare array), parse it, and validate it fail-closed:
 *  array of length exactly `n`, every field present and non-empty, ids unique kebab-case, kind
 *  restricted to happy/edge with at least one edge, disqualifiers 1-3 non-empty strings. On ANY
 *  violation throws ONE error listing every violation found (operator-readable - the retry prompt
 *  quotes it verbatim). */
export function parseCases(text: string, n: number): ProofCase[] {
  const block = extractJsonBlock(text);
  if (block === undefined) {
    throw new Error("no json found in the agent's response (no ```json fenced block and no bare JSON array)");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (e) {
    throw new Error(`could not parse the extracted json: ${e instanceof Error ? e.message : String(e)}`);
  }

  const violations: string[] = [];

  if (!Array.isArray(parsed)) {
    throw new Error("the parsed json is not an array of cases");
  }
  if (parsed.length !== n) {
    violations.push(`expected exactly ${n} cases, got ${parsed.length} (count mismatch)`);
  }

  const ids = new Set<string>();
  let edgeCount = 0;

  parsed.forEach((raw, i) => {
    const c = raw as Partial<ProofCase> | null | undefined;
    const label = `case[${i}]${isNonEmptyString(c?.id) ? ` (${c!.id})` : ""}`;

    if (!isNonEmptyString(c?.id)) {
      violations.push(`${label}: missing or empty "id"`);
    } else if (!KEBAB_CASE.test(c!.id)) {
      violations.push(`${label}: "id" must be kebab-case (${JSON.stringify(c!.id)})`);
    } else if (c!.id.length > MAX_ID_LENGTH) {
      violations.push(`${label}: "id" must be at most ${MAX_ID_LENGTH} characters (got ${c!.id.length})`);
    } else if (ids.has(c!.id)) {
      violations.push(`${label}: duplicate "id" (${JSON.stringify(c!.id)})`);
    } else {
      ids.add(c!.id);
    }

    if (!isNonEmptyString(c?.title)) violations.push(`${label}: missing or empty "title"`);
    if (!isNonEmptyString(c?.prompt)) violations.push(`${label}: missing or empty "prompt"`);
    if (!isNonEmptyString(c?.expected)) violations.push(`${label}: missing or empty "expected"`);

    if (c?.kind !== "happy" && c?.kind !== "edge") {
      violations.push(`${label}: "kind" must be "happy" or "edge" (got ${JSON.stringify(c?.kind)})`);
    } else if (c.kind === "edge") {
      edgeCount++;
    }

    const dq = c?.disqualifiers;
    if (!Array.isArray(dq) || dq.length < 1 || dq.length > 3 || !dq.every(isNonEmptyString)) {
      violations.push(`${label}: "disqualifiers" must be an array of 1-3 non-empty strings`);
    }
  });

  if (edgeCount === 0) {
    violations.push('at least one case must have kind "edge"');
  }

  if (violations.length > 0) {
    throw new Error(`generated cases failed validation:\n- ${violations.join("\n- ")}`);
  }

  return parsed as ProofCase[];
}

/** Run the generator prompt through the agent seam (no allowedTools - the generator gets no MCP
 *  tools, it only writes test cases), collect its text events, and parse fail-closed. On a failed
 *  attempt (an error event, zero text collected, or a validation failure) retries ONCE with the
 *  original prompt plus the quoted validation error; a second failure throws that error (redacted). */
export async function generateCases(
  driver: AgentDriver,
  opts: { workspace: string; surface: Surface; n: number; redact: string[]; mcpConfigPath?: string },
): Promise<ProofCase[]> {
  const prompt = buildGeneratorPrompt(opts.surface, opts.n);

  const attempt = async (thisPrompt: string): Promise<ProofCase[]> => {
    let text = "";
    let sawError: string | undefined;
    // Strict-mcp against the caller's (empty) config keeps the operator's claude.ai connectors out
    // of the generator's reach - defense in depth atop its already-empty allowedTools.
    const runOpts: RunPromptOpts = { prompt: thisPrompt, workspace: opts.workspace, ...(opts.mcpConfigPath ? { mcpConfigPath: opts.mcpConfigPath } : {}) };
    for await (const event of driver.runPrompt(runOpts)) {
      if (event.kind === "text") text += (text ? "\n" : "") + event.text;
      if (event.kind === "error") sawError = event.message;
    }
    if (sawError !== undefined) {
      throw new Error(`agent driver reported an error: ${sawError}`);
    }
    if (!text) {
      throw new Error("no json found in the agent's response (no text produced)");
    }
    return parseCases(text, opts.n);
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
