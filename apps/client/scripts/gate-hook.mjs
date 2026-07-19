// BuildEx approval-card gate hook (invariant 5 - outward/irreversible ⇒ human-gated). Claude Code
// runs this as a PreToolUse "command" hook before every tool call. It relays the tool to the
// daemon's gate (POST /api/gate), which applies the allow/ask/deny policy and - for ask-tier -
// BLOCKS on the operator's approval card until they tap approve/deny (or the card's TTL expires to
// deny). The daemon's terminal allow/deny is mapped to Claude Code's PreToolUse permission decision,
// so the daemon gate - not Claude's native prompt - is the single source of truth.
//
//   node gate-hook.mjs <daemon-base-url>      # e.g. node gate-hook.mjs http://127.0.0.1:4317
//
// Plain ESM run via `node` (NOT tsx): the hook fires on EVERY tool call, so its startup must be
// cheap - a transpile step per call would make the console feel sluggish. Self-contained, zero deps.
//
// FAIL CLOSED. On ANY failure (missing URL, unreadable payload, daemon unreachable, non-2xx, bad
// body) the hook DENIES. This is subtle: Claude treats a hook's *nonzero exit* as a NON-blocking
// error that lets the tool PROCEED ungated, and a *timeout* the same way. So we never exit nonzero
// and never hang past the daemon's own card TTL - on failure we exit 0 with permissionDecision
// "deny". Getting this wrong would silently open the gate, which is the whole thing we're closing.
import { argv, stdin, stdout, exit } from "node:process";
import { pathToFileURL } from "node:url";

/** Build the PreToolUse stdout object for a terminal gate decision (allow | deny). */
export function decisionOutput(permissionDecision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
    },
  };
}

/** Extract the tool invocation the daemon gate expects ({ name, input }) from a PreToolUse payload. */
export function toolFromPayload(payload) {
  const name = payload && typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input =
    payload && typeof payload.tool_input === "object" && payload.tool_input !== null ? payload.tool_input : {};
  return { name, input };
}

/**
 * Core hook logic, factored out (and injectable) so it is unit-testable without a socket - the test
 * sandbox blocks inter-process loopback TCP, so we inject `fetchImpl` rather than stand up a
 * server. Returns `{ output, code }`: `output` is JSON-printed to stdout, `code` is the exit code -
 * ALWAYS 0, so Claude honors the JSON decision (a nonzero code would let the tool proceed ungated).
 * @param {{ stdinText: string, baseUrl: string | undefined, fetchImpl: typeof fetch }} deps
 * @returns {Promise<{ output: object, code: number }>}
 */
export async function runGateHook({ stdinText, baseUrl, fetchImpl }) {
  const deny = (reason) => ({ output: decisionOutput("deny", reason), code: 0 });

  if (!baseUrl) return deny("gate: no daemon URL configured for the approval hook");

  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return deny("gate: unreadable PreToolUse payload");
  }

  const tool = toolFromPayload(payload);
  if (!tool.name) return deny("gate: missing tool name in the PreToolUse payload");

  let res;
  try {
    res = await fetchImpl(new URL("/api/gate", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: tool.name, input: tool.input }),
    });
  } catch (e) {
    return deny(`gate: daemon unreachable (${e instanceof Error ? e.message : String(e)})`);
  }

  if (!res.ok) return deny(`gate: daemon returned ${res.status}`);

  let body;
  try {
    body = await res.json();
  } catch {
    return deny("gate: unreadable gate response");
  }

  if (body && body.decision === "allow")
    return { output: decisionOutput("allow", "approved by the operator gate"), code: 0 };
  if (body && body.decision === "deny")
    return { output: decisionOutput("deny", "blocked by the operator gate"), code: 0 };
  return deny(`gate: unexpected gate decision ${JSON.stringify(body && body.decision)}`);
}

/** Read all of stdin (the PreToolUse payload Claude pipes in) as UTF-8 text. */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (c) => (data += c));
    stdin.on("end", () => resolve(data));
  });
}

async function main() {
  const { output, code } = await runGateHook({
    stdinText: await readStdin(),
    baseUrl: argv[2],
    fetchImpl: fetch,
  });
  stdout.write(JSON.stringify(output));
  exit(code);
}

// Run only when executed directly (`node gate-hook.mjs …`), not when imported by a test.
if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  void main();
}
