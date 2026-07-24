// The grounding phase. Before scenarios are generated, drive a READ-ONLY agent against the live
// pinned pack to catalog the REAL entities that already exist (client names, template names, ids,
// counts). That catalog feeds the generator so scenarios reference things that actually exist.
//
// Why this phase exists: the generator sees only the pack's SURFACE (skills + tool schemas), never
// its data. Left blind, it invents plausible specifics - a client "Marcus Webb", a template
// "Hypertrophy Base" - that the instance never had. The driven agent then correctly cannot find
// them, and the judge fails the case for a reason that has nothing to do with the pack under test.
// Grounding the generator in real data closes that false negative at the source.
//
// Fail-soft by contract: exploration is best-effort grounding, never a gate. An errored or empty
// exploration returns "" so the caller falls back to ungrounded generation - exactly the behavior
// from before this phase existed, never worse.
import type { AgentDriver, RunPromptOpts } from "../agent/types.js";
import type { Surface } from "./discover.js";
import { redactText } from "./redact.js";

/** The explorer's prompt: catalog the REAL entities the live pack contains, read-only, no inventing.
 *  The surface rides verbatim so the agent knows which tools exist; the instruction constrains it to
 *  read/list/search/get-style calls (the engine is provider-neutral and cannot know per-tool which
 *  are read-only, so the constraint is stated, and the phase runs only against disposable instances -
 *  the local lane's throwaway instance or a minted sandbox). */
export function buildExplorePrompt(surface: Surface): string {
  return `You are cataloging the REAL data that already exists in a software pack's live instance, so
that end-to-end test scenarios can reference entities that actually exist instead of invented ones.

Here is the pack's surface (its skills and tools) - the capabilities you may use:

\`\`\`json
${JSON.stringify(surface, null, 2)}
\`\`\`

Using ONLY read-only tools - the pack's find / list / search / get / review-style tools, plus Read -
explore the instance and report the concrete entities that are actually present. NEVER create,
update, delete, assign, message, book, or otherwise modify anything. Do NOT invent or guess: report
ONLY what the tools actually return.

Produce a concise catalog a scenario author can draw on. Include, where they exist:
- real client / contact / customer names (with ids if the tools show them)
- real template / program / plan / project names
- notable records, appointments, tasks, or counts that exist
- anything else concrete a realistic day-in-the-life task would name

If the instance is empty or a category has nothing, say so plainly. Keep it under ~40 lines. Output
the catalog as plain text - no preamble, no fenced block, just the catalog.`;
}

/**
 * Drive the read-only explorer and return its catalog text (redacted). Returns "" on any failure or
 * empty output - the caller treats "" as "no grounding available" and generates ungrounded, so a
 * broken exploration degrades to the pre-grounding behavior rather than taking the run down.
 */
export async function exploreData(
  driver: AgentDriver,
  opts: { workspace: string; surface: Surface; allowedTools: string[]; mcpConfigPath?: string; redact: string[] },
): Promise<string> {
  const runOpts: RunPromptOpts = {
    prompt: buildExplorePrompt(opts.surface),
    workspace: opts.workspace,
    allowedTools: opts.allowedTools,
    ...(opts.mcpConfigPath ? { mcpConfigPath: opts.mcpConfigPath } : {}),
  };
  let text = "";
  let sawError = false;
  try {
    for await (const event of driver.runPrompt(runOpts)) {
      if (event.kind === "text") text += (text ? "\n" : "") + event.text;
      if (event.kind === "error") sawError = true;
    }
  } catch {
    sawError = true;
  }
  if (sawError || !text.trim()) return "";
  return redactText(text, opts.redact);
}
