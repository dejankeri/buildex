// Unit tests for the PreToolUse gate hook (../../scripts/gate-hook.mjs). The hook's core is factored
// out with an injectable fetch so it is testable WITHOUT a socket - the test sandbox blocks
// inter-process loopback TCP, so we never stand up a real daemon here; the full socket path is
// covered by the live smoke instead. The contract these tests pin: the hook maps the daemon's
// allow/deny to Claude's PreToolUse permissionDecision, and it FAILS CLOSED (deny, never a nonzero
// exit) on every error path - because Claude treats a nonzero hook exit as non-blocking and would let
// the tool proceed ungated.
import { describe, it, expect, vi } from "vitest";
import { runGateHook, toolFromPayload } from "../../scripts/gate-hook.mjs";

const BASE = "http://127.0.0.1:9999";
const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" }, ...over });
const gateFetch = (decision: string, status = 200) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ decision }), { status, headers: { "content-type": "application/json" } }),
  );

describe("toolFromPayload", () => {
  it("maps tool_name/tool_input to the daemon's { name, input } shape", () => {
    expect(toolFromPayload({ tool_name: "SendEmail", tool_input: { to: "x@y" } })).toEqual({
      name: "SendEmail",
      input: { to: "x@y" },
    });
  });
  it("defaults missing name to '' and missing/invalid input to {}", () => {
    expect(toolFromPayload({})).toEqual({ name: "", input: {} });
    expect(toolFromPayload({ tool_name: "Read", tool_input: null })).toEqual({ name: "Read", input: {} });
  });
});

describe("runGateHook", () => {
  it("maps an 'allow' decision to permissionDecision 'allow' (exit 0), POSTing the tool to /api/gate", async () => {
    const fetchImpl = gateFetch("allow");
    const { output, code } = await runGateHook({ stdinText: payload(), baseUrl: BASE, fetchImpl });
    expect(code).toBe(0);
    expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
    // it consulted the daemon gate with the right URL + body
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/api/gate`);
    expect(JSON.parse(init!.body as string)).toEqual({ name: "Bash", input: { command: "git push" } });
  });

  it("maps a 'deny' decision to permissionDecision 'deny' (exit 0)", async () => {
    const { output, code } = await runGateHook({ stdinText: payload(), baseUrl: BASE, fetchImpl: gateFetch("deny") });
    expect(code).toBe(0);
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("FAILS CLOSED (deny, exit 0) when the daemon is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { output, code } = await runGateHook({ stdinText: payload(), baseUrl: BASE, fetchImpl });
    expect(code).toBe(0); // never nonzero - that would let the tool proceed ungated
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/unreachable/);
  });

  it("FAILS CLOSED when the daemon returns a non-2xx status", async () => {
    const { output } = await runGateHook({ stdinText: payload(), baseUrl: BASE, fetchImpl: gateFetch("allow", 500) });
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/500/);
  });

  it("FAILS CLOSED on an unreadable payload without ever calling the daemon", async () => {
    const fetchImpl = gateFetch("allow");
    const { output, code } = await runGateHook({ stdinText: "not json", baseUrl: BASE, fetchImpl });
    expect(code).toBe(0);
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when no daemon URL is configured", async () => {
    const fetchImpl = gateFetch("allow");
    const { output } = await runGateHook({ stdinText: payload(), baseUrl: undefined, fetchImpl });
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
