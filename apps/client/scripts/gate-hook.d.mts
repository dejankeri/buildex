// Types for the plain-ESM gate hook (gate-hook.mjs). The hook ships as .mjs so it runs under bare
// `node` with no transpile (it fires on every tool call); this declaration lets the TypeScript unit
// test import its factored-out, injectable helpers without enabling allowJs across the project.

/** The PreToolUse stdout object for a terminal gate decision. */
export function decisionOutput(
  permissionDecision: "allow" | "deny",
  reason: string,
): {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
};

/** Extract { name, input } for the daemon gate from a PreToolUse stdin payload. */
export function toolFromPayload(payload: unknown): { name: string; input: Record<string, unknown> };

/** Core hook logic (injectable fetch). Always returns code 0 so Claude honors the JSON decision. */
export function runGateHook(deps: {
  stdinText: string;
  baseUrl: string | undefined;
  fetchImpl: typeof fetch;
}): Promise<{
  output: {
    hookSpecificOutput: {
      hookEventName: "PreToolUse";
      permissionDecision: "allow" | "deny";
      permissionDecisionReason: string;
    };
  };
  code: number;
}>;
