import { describe, it, expect } from "vitest";
import { createDaemon, type ConnectorControl, type ConnectorGatewayView } from "./daemon.js";
import { Gate } from "../gate/gate.js";
import { PolicyEngine } from "../gate/policy.js";
import { ApprovalBroker } from "../gate/approval.js";
import type { UiEvent } from "../agent/types.js";

function makeDaemon() {
  const finished: { name: string; code: string; state: string }[] = [];
  const connectorHub: ConnectorControl = {
    catalog: () => [{ name: "gmail", auth: "oauth", cadence: "15m", description: "", connected: false, needsAuth: true }],
    connect: () => {},
    disconnect: () => {},
    sync: async () => ({ wrote: 0 }),
    beginAuth: (name) => ({ authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=st&connector=${name}` }),
    finishAuth: async (name, code, state) => {
      if (state !== "good") throw new Error("authorization state mismatch");
      finished.push({ name, code, state });
    },
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
    connectorHub,
  });
  return { daemon, finished };
}

describe("file-connector OAuth routes", () => {
  it("POST /api/connectors/<name>/authorize returns the provider authorize URL", async () => {
    const { daemon } = makeDaemon();
    const res = await daemon(new Request("http://127.0.0.1/api/connectors/gmail/authorize", { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authorizeUrl: string }).authorizeUrl).toContain("accounts.google.com");
  });

  it("GET /oauth/connector/<name>/callback finishes auth and returns a success page", async () => {
    const { daemon, finished } = makeDaemon();
    const res = await daemon(new Request("http://127.0.0.1/oauth/connector/gmail/callback?code=abc&state=good"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/html/);
    expect(await res.text()).toMatch(/Connected/i);
    expect(finished).toEqual([{ name: "gmail", code: "abc", state: "good" }]);
  });

  it("rejects a callback missing code or state (400, no finishAuth)", async () => {
    const { daemon, finished } = makeDaemon();
    const res = await daemon(new Request("http://127.0.0.1/oauth/connector/gmail/callback?code=abc"));
    expect(res.status).toBe(400);
    expect(finished).toHaveLength(0);
  });

  it("surfaces a finishAuth failure (bad state) as a 400 page", async () => {
    const { daemon } = makeDaemon();
    const res = await daemon(new Request("http://127.0.0.1/oauth/connector/gmail/callback?code=abc&state=WRONG"));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/failed|mismatch/i);
  });

  it("is distinct from the MCP gateway callback path (no gatewayView here → that path 404s)", async () => {
    const { daemon } = makeDaemon();
    const res = await daemon(new Request("http://127.0.0.1/oauth/gmail/callback?code=abc"));
    expect(res.status).toBe(404);
  });
});

// The MCP gateway's own callback (/oauth/<name>/callback) - same CSRF discipline as the
// file-connector route: state is required and forwarded, and a hub rejection surfaces as a 400 page.
function makeGatewayDaemon() {
  const finished: { name: string; code: string; state: string }[] = [];
  const gatewayView: ConnectorGatewayView = {
    status: () => [],
    tools: () => [],
    add: async () => ({ name: "linear", connected: false, needsAuth: true, tools: 0 }),
    remove: () => {},
    setPolicy: () => ({ ok: true }),
    finishAuth: async (name, code, state) => {
      if (state !== "good") throw new Error("authorization state mismatch");
      finished.push({ name, code, state });
      return { connected: true, tools: 2 };
    },
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
  return { daemon, finished };
}

describe("MCP-gateway OAuth callback - CSRF state required (invariant 7)", () => {
  it("finishes auth when the callback carries the valid state", async () => {
    const { daemon, finished } = makeGatewayDaemon();
    const res = await daemon(new Request("http://127.0.0.1/oauth/linear/callback?code=abc&state=good"));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Connected/i);
    expect(finished).toEqual([{ name: "linear", code: "abc", state: "good" }]);
  });

  it("rejects a callback with no state (400, finishAuth never called)", async () => {
    const { daemon, finished } = makeGatewayDaemon();
    const res = await daemon(new Request("http://127.0.0.1/oauth/linear/callback?code=abc"));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/missing code or state/i);
    expect(finished).toHaveLength(0);
  });

  it("rejects a callback with no code (400, finishAuth never called)", async () => {
    const { daemon, finished } = makeGatewayDaemon();
    const res = await daemon(new Request("http://127.0.0.1/oauth/linear/callback?state=good"));
    expect(res.status).toBe(400);
    expect(finished).toHaveLength(0);
  });

  it("surfaces a state mismatch from the hub as a 400 page (nothing registered)", async () => {
    const { daemon, finished } = makeGatewayDaemon();
    const res = await daemon(new Request("http://127.0.0.1/oauth/linear/callback?code=abc&state=FORGED"));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/mismatch/i);
    expect(finished).toHaveLength(0);
  });
});
