// A gated tool call, in words. The Loops panel says what a run needed a human for ("it tried to
// send an email to ops@acme.com"), and that sentence has to be produced by the daemon - the run
// that raised the card is long over by the time anyone looks.
//
// The console has its own copy of this phrasing (humanizeCard in web/js/pending.js) because the
// console is classic script and this is TypeScript; the two must stay in step. Deterministic
// (invariant 9): pure string work over the recorded invocation, no model in the loop.
import type { ToolInvocation } from "./policy.js";

/** One short clause naming what the tool would have done. Never includes secrets or full payloads. */
export function describeTool(tool: ToolInvocation): string {
  const input = tool.input ?? {};
  const args = isRecord(input["args"]) ? input["args"] : {};

  // A connector/gateway action ships its own human summary - always prefer it.
  const summary = str(input["summary"]);
  if (summary) return summary;

  const recipient = str(args["to"]) ?? str(input["to"]) ?? str(input["recipient"]) ?? str(args["recipient"]);
  const looksLikeSend = /gmail|mail|email/i.test(tool.name) || input["tool"] === "send" || (recipient && /send/i.test(tool.name));
  if (looksLikeSend && recipient) return `send an email to ${recipient}`;

  const skill = str(input["skill"]);
  if (tool.name === "Skill" || skill) return `run the ${skill ?? "requested"} skill`;

  const url = str(input["url"]);
  if (tool.name === "WebFetch" || url) {
    let host = url ?? "";
    try {
      host = new URL(url!).hostname;
    } catch {
      /* not a parseable URL - keep whatever was there */
    }
    return `fetch ${host || "a web page"}`;
  }

  const query = str(input["query"]);
  if (tool.name === "WebSearch" || query) return `search the web for "${query ?? ""}"`;

  const command = str(input["command"]);
  if (tool.name === "Bash" || command) return command ? `run \`${clip(command)}\`` : "run a shell command";

  return `use ${tool.name}`;
}

/** The activity-ledger clause: the connector's name (when the call rode the gateway or the
 *  provision proxy - both stamp `input.connector`) in front of the same sentence the card showed.
 *  One phrasing path: this builds ON describeTool, so the ledger can never drift from the tray. */
export function describeAction(tool: ToolInvocation): string {
  const connector = str((tool.input ?? {})["connector"]);
  const clause = describeTool(tool);
  return connector ? `${connector}: ${clause}` : clause;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Keep a command to a glanceable length - the card is a sentence, not a transcript. */
function clip(v: string): string {
  return v.length <= 60 ? v : v.slice(0, 57) + "…";
}
