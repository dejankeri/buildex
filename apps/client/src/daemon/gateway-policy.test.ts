import { describe, it, expect } from "vitest";
import { createDaemon, type ConnectorGatewayView } from "./daemon.js";
import { Gate } from "../gate/gate.js";
import { PolicyEngine } from "../gate/policy.js";
import { ApprovalBroker } from "../gate/approval.js";
import type { UiEvent } from "../agent/types.js";

// A stub gateway view that records setPolicy calls and mirrors the hub's ok/err contract, so we
// exercise the route's validation + wiring without standing up the real gateway.
function makeDaemon() {
  const calls: { name: string; tool: string; kind: string }[] = [];
  const gatewayView: ConnectorGatewayView = {
    status: () => [{ name: "gmail", connected: true, needsAuth: false, tools: 2 }],
    tools: () => [
      { name: "gmail__search", kind: "read", baseline: "read", description: "search" },
      { name: "gmail__send", kind: "gated", baseline: "gated", description: "send mail" },
    ],
    add: async () => ({ name: "gmail", connected: true, needsAuth: false, tools: 2 }),
    remove: () => {},
    setPolicy: (name, tool, kind) => {
      calls.push({ name, tool, kind });
      // the real hub returns ok:false for an unknown tool - used to exercise the route's 400 path
      if (tool !== "search" && tool !== "send") return { ok: false, reason: `unknown tool: ${tool}` };
      return { ok: true };
    },
    finishAuth: async () => ({ connected: true, tools: 2 }),
  };
  const broker = new ApprovalBroker({ idFactory: () => "c1", now: () => 0 });
  const daemon = createDaemon({
    workspace: "/ws",
    roots: [],
    gate: new Gate(new PolicyEngine({ allow: [], ask: [], deny: [], default: "ask" }), broker),
    broker,
    async *runPrompt() { yield { kind: "done" } as UiEvent; },
    buildMap: () => ({ nodes: [], edges: [] }),
    syncFn: async () => "ok",
    gatewayView,
  });
  return { daemon, calls };
}

const post = (path: string, b: unknown) =>
  new Request("http://127.0.0.1" + path, { method: "POST", body: JSON.stringify(b) });

describe("POST /api/connectors/gateway/<name>/policy - operator-adjustable tool reclassification", () => {
  it("tools() exposes the effective kind + intrinsic baseline (the trust surface)", async () => {
    const { daemon } = makeDaemon();
    const res = await daemon(new Request("http://127.0.0.1/api/connectors/gateway"));
    const body = (await res.json()) as { tools: { name: string; kind: string; baseline: string }[] };
    expect(body.tools.find((t) => t.name === "gmail__send")).toMatchObject({ kind: "gated", baseline: "gated" });
  });

  it("accepts a tighten (read→gated) and forwards it to the view", async () => {
    const { daemon, calls } = makeDaemon();
    const res = await daemon(post("/api/connectors/gateway/gmail/policy", { tool: "search", kind: "gated" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toContainEqual({ name: "gmail", tool: "search", kind: "gated" });
  });

  it("accepts widening an outward tool (send→read) and forwards it to the view", async () => {
    const { daemon, calls } = makeDaemon();
    const res = await daemon(post("/api/connectors/gateway/gmail/policy", { tool: "send", kind: "read" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toContainEqual({ name: "gmail", tool: "send", kind: "read" });
  });

  it("propagates a view error (unknown tool) as a 400", async () => {
    const { daemon } = makeDaemon();
    const res = await daemon(post("/api/connectors/gateway/gmail/policy", { tool: "ghost", kind: "read" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown tool/i);
  });

  it("rejects an unknown kind before touching the view", async () => {
    const { daemon, calls } = makeDaemon();
    const res = await daemon(post("/api/connectors/gateway/gmail/policy", { tool: "search", kind: "nuke" }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("requires a tool name", async () => {
    const { daemon } = makeDaemon();
    const res = await daemon(post("/api/connectors/gateway/gmail/policy", { kind: "hidden" }));
    expect(res.status).toBe(400);
  });
});
