import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDriver, UiEvent } from "../agent/types.js";
import { redactText } from "./redact.js";

export interface DriveResult {
  /** Which case this drive ran, carried alongside the result so callers with several drives never
   *  have to zip it back together from a parallel array (see results.ts's collectResults). */
  caseId: string;
  events: (UiEvent & { at: string })[];
  toolCalls: number;
  /** A failed tool call is data, not a verdict — scenarios legitimately include refusals;
   * the judge and results decide what a failure means per case. */
  toolFailures: number;
  errored: boolean;
  transcriptPath: string;
}

export interface DriveCaseOpts {
  workspace: string;
  prompt: string;
  runDir: string;
  caseId: string;
  /** Permission rules pre-granted for the spawn (see RunPromptOpts.allowedTools) - the harness's
   *  fresh workspaces are never folder-trusted, so settings.json permissions alone cannot grant
   *  the pinned pack's MCP tools to a headless session. */
  allowedTools?: string[];
  /** Secret values (pinned keys, admin secrets) scrubbed from the PERSISTED transcript - the one
   *  artifact that survives the run. In-memory events keep their raw form for counting. */
  redact?: string[];
  now?: () => Date;
}

export async function driveCase(
  driver: AgentDriver,
  opts: DriveCaseOpts
): Promise<DriveResult> {
  const stampedEvents: (UiEvent & { at: string })[] = [];
  let toolCalls = 0;
  let toolFailures = 0;
  let errored = false;

  const getNow = opts.now ?? (() => new Date());

  // A drive must never lose its transcript and must never mistake a crash for a pass. So: a
  // mid-stream iterator throw becomes a captured error event (no rethrow - the driver's failure IS
  // the case's result), a stream that just ends with neither done nor error is a crashed agent
  // (errored), and the transcript is written from whatever was captured, always.
  let sawTerminal = false;
  try {
    for await (const event of driver.runPrompt({
      prompt: opts.prompt,
      workspace: opts.workspace,
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
    })) {
      const stampedEvent = {
        ...event,
        at: getNow().toISOString(),
      };
      stampedEvents.push(stampedEvent);

      if (event.kind === "tool") {
        toolCalls++;
      }

      if (event.kind === "tool_result" && !event.ok) {
        toolFailures++;
      }

      if (event.kind === "error") {
        errored = true;
        sawTerminal = true;
      }
      if (event.kind === "done") {
        sawTerminal = true;
      }
    }
  } catch (e) {
    errored = true;
    sawTerminal = true;
    stampedEvents.push({ kind: "error", message: e instanceof Error ? e.message : String(e), at: getNow().toISOString() });
  }
  if (!sawTerminal) {
    errored = true;
  }

  // Write the transcript, scrubbing any secrets a caller declared (the pinned key would otherwise
  // survive the run if the agent ever quoted .mcp.json).
  const transcriptDir = join(opts.runDir, "transcripts");
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, `${opts.caseId}.json`);
  const serialized = redactText(JSON.stringify(stampedEvents, null, 2), opts.redact ?? []);
  writeFileSync(transcriptPath, serialized);

  return {
    caseId: opts.caseId,
    events: stampedEvents,
    toolCalls,
    toolFailures,
    errored,
    transcriptPath,
  };
}
