import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDriver, UiEvent } from "../agent/types.js";

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

  for await (const event of driver.runPrompt({
    prompt: opts.prompt,
    workspace: opts.workspace,
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
    }
  }

  // Write transcript to disk
  const transcriptDir = join(opts.runDir, "transcripts");
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, `${opts.caseId}.json`);
  writeFileSync(transcriptPath, JSON.stringify(stampedEvents, null, 2));

  return {
    caseId: opts.caseId,
    events: stampedEvents,
    toolCalls,
    toolFailures,
    errored,
    transcriptPath,
  };
}
