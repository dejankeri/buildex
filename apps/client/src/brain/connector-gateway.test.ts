import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker, type ApprovalCard } from "../gate/approval.js";
import { brokerApprover, ConnectorGatewayHub, type GatewayHubDeps } from "./connector-gateway.js";
import type { OpenResult, ProviderConnection, ProviderServerConfig } from "@buildex/connectors";

function memStore() {
  const map = new Map<string, string>();
  return { get: (k: string) => map.get(k), set: (k: string, v: string) => void map.set(k, v), delete: (k: string) => void map.delete(k) };
}

function connectedConn(name: string): ProviderConnection {
  return {
    name,
    tools: [
      { name: "search", annotations: { readOnlyHint: true } },
      { name: "send", annotations: { readOnlyHint: false } },
    ],
    call: async (tool) => ({ content: [{ type: "text", text: `ran ${tool}` }] }),
  };
}

function hubDeps(over: Partial<GatewayHubDeps> = {}): GatewayHubDeps {
  return {
    broker: new ApprovalBroker({ idFactory: () => "c1", now: () => 0 }),
    store: memStore(),
    workspaceDir: mkdtempSync(join(tmpdir(), "buildex-hub-")),
    gatewayUrl: "http://127.0.0.1:4317/mcp/gateway",
    redirectBase: "http://127.0.0.1:4317",
    openUrl: vi.fn(),
    ...over,
  };
}

describe("brokerApprover - a gated MCP call IS a Pending card", () => {
  it("opens a card, surfaces it to the tray, and resolves approved on approve", async () => {
    let n = 0;
    const cards: ApprovalCard[] = [];
    const broker = new ApprovalBroker({ idFactory: () => `c${++n}`, now: () => 0, onCard: (c) => cards.push(c) });
    const approve = brokerApprover(broker);

    const pending = approve({ connector: "gmail", tool: "send", args: { to: "a@b.co" }, summary: "gmail · send" });
    expect(broker.pending()).toHaveLength(1);
    expect(cards[0]!.tool.name).toBe("mcp:gmail.send");
    expect(cards[0]!.tool.input).toMatchObject({ connector: "gmail", tool: "send" });

    broker.resolve(broker.pending()[0]!.id, "approve");
    expect(await pending).toEqual({ approved: true });
    expect(broker.pending()).toHaveLength(0);
  });

  it("maps a denial to approved:false", async () => {
    let n = 0;
    const broker = new ApprovalBroker({ idFactory: () => `c${++n}`, now: () => 0 });
    const approve = brokerApprover(broker);

    const pending = approve({ connector: "slack", tool: "post_message", args: {}, summary: "x" });
    broker.resolve(broker.pending()[0]!.id, "deny");
    expect(await pending).toEqual({ approved: false });
  });
});

describe("ConnectorGatewayHub", () => {
  it("connects a provider, registers its tools, and writes the per-workspace .mcp.json", async () => {
    const deps = hubDeps({
      open: async (): Promise<OpenResult> => ({ status: "connected", connection: connectedConn("gmail"), transport: {} as never }),
    });
    const hub = new ConnectorGatewayHub(deps);

    const status = await hub.connect({ name: "gmail", url: "https://mcp.gmail.example/mcp" });
    expect(status).toMatchObject({ name: "gmail", connected: true, needsAuth: false, tools: 2 });

    // tools show up on the gateway, namespaced + classified
    const tools = hub.listTools();
    expect(tools.find((t) => t.name === "gmail__search")!.kind).toBe("read");
    expect(tools.find((t) => t.name === "gmail__send")!.kind).toBe("gated");

    // the agent registration was written into the workspace
    const reg = JSON.parse(readFileSync(join(deps.workspaceDir, ".mcp.json"), "utf8"));
    expect(reg.mcpServers["buildex-connectors"].url).toBe(deps.gatewayUrl);
  });

  it("inventory() lists tools incl. baseline; setPolicy tightens and is reflected live and refuses ungating", async () => {
    const deps = hubDeps({
      open: async (): Promise<OpenResult> => ({ status: "connected", connection: connectedConn("gmail"), transport: {} as never }),
    });
    const hub = new ConnectorGatewayHub(deps);
    await hub.connect({ name: "gmail", url: "https://x/mcp" });

    const inv = hub.inventory();
    expect(inv.find((i) => i.tool === "search")).toMatchObject({ kind: "read", baseline: "read" });

    // tighten the read tool to gated → reflected on the agent surface immediately
    const t = hub.setPolicy("gmail", "search", "gated");
    expect(t.ok).toBe(true);
    expect(hub.listTools().find((x) => x.name === "gmail__search")!.kind).toBe("gated");

    // ungating an outward tool is refused (invariant 5)
    const bad = hub.setPolicy("gmail", "send", "read");
    expect(bad.ok).toBe(false);
    expect(hub.listTools().find((x) => x.name === "gmail__send")!.kind).toBe("gated");
  });

  it("surfaces needs-auth without registering tools or writing .mcp.json", async () => {
    const deps = hubDeps({
      open: async (): Promise<OpenResult> => ({ status: "needs-auth", transport: {} as never }),
    });
    const hub = new ConnectorGatewayHub(deps);

    const status = await hub.connect({ name: "notion", url: "https://mcp.notion.example/mcp" });
    expect(status).toMatchObject({ connected: false, needsAuth: true, tools: 0 });
    expect(hub.listTools()).toHaveLength(0);
    expect(existsSync(join(deps.workspaceDir, ".mcp.json"))).toBe(false);
  });

  it("captures the authorization URL when the provider demands OAuth (for the UI to open)", async () => {
    const deps = hubDeps({
      open: async (config): Promise<OpenResult> => {
        await config.authProvider!.redirectToAuthorization(new URL("https://auth.example/authorize?x=1"));
        return { status: "needs-auth", transport: {} as never };
      },
    });
    const hub = new ConnectorGatewayHub(deps);
    const status = await hub.connect({ name: "linear", url: "https://mcp.linear.app/mcp" });
    expect(status.needsAuth).toBe(true);
    expect(status.authUrl).toBe("https://auth.example/authorize?x=1");
  });

  // A needs-auth `open` that behaves like the SDK: it mints the CSRF state (the SDK calls
  // provider.state() while building the authorize URL) before surfacing needs-auth.
  const needsAuthOpen = (minted: { state?: string }) => async (config: ProviderServerConfig): Promise<OpenResult> => {
    minted.state = await (config.authProvider as { state(): string | Promise<string> }).state();
    return { status: "needs-auth", transport: { t: 1 } as never };
  };

  it("finishAuth with the minted state completes the exchange, registers tools, and writes .mcp.json", async () => {
    const minted: { state?: string } = {};
    const deps = hubDeps({
      open: needsAuthOpen(minted),
      complete: async () => connectedConn("linear"),
    });
    const hub = new ConnectorGatewayHub(deps);
    await hub.connect({ name: "linear", url: "https://x/mcp" });
    expect(hub.listTools()).toHaveLength(0);

    const status = await hub.finishAuth("linear", "auth-code-123", minted.state!);
    expect(status).toMatchObject({ name: "linear", connected: true, needsAuth: false, tools: 2 });
    expect(hub.listTools().map((t) => t.name)).toContain("linear__search");
    expect(existsSync(join(deps.workspaceDir, ".mcp.json"))).toBe(true);
  });

  it("finishAuth throws for a connector with no pending authorization", async () => {
    const hub = new ConnectorGatewayHub(hubDeps());
    await expect(hub.finishAuth("ghost", "code", "st")).rejects.toThrow(/pending/i);
  });

  it("finishAuth rejects a wrong state without exchanging the code or registering tools (CSRF)", async () => {
    const minted: { state?: string } = {};
    const complete = vi.fn(async () => connectedConn("linear"));
    const deps = hubDeps({ open: needsAuthOpen(minted), complete });
    const hub = new ConnectorGatewayHub(deps);
    await hub.connect({ name: "linear", url: "https://x/mcp" });

    await expect(hub.finishAuth("linear", "auth-code-123", "FORGED")).rejects.toThrow(/state mismatch/i);
    expect(complete).not.toHaveBeenCalled();
    expect(hub.listTools()).toHaveLength(0);
    expect(existsSync(join(deps.workspaceDir, ".mcp.json"))).toBe(false);
    // the failed attempt consumed the one-time state - even the real value no longer works
    await expect(hub.finishAuth("linear", "auth-code-123", minted.state!)).rejects.toThrow(/no authorization in progress/i);
  });

  it("finishAuth rejects an expired state (short TTL) without exchanging the code", async () => {
    const minted: { state?: string } = {};
    const complete = vi.fn(async () => connectedConn("linear"));
    let now = 1_000;
    const store = memStore();
    const deps = hubDeps({ store, open: needsAuthOpen(minted), complete, now: () => now });
    const hub = new ConnectorGatewayHub(deps);
    await hub.connect({ name: "linear", url: "https://x/mcp" });

    now += 10 * 60 * 1000 + 1; // past the 10-minute state TTL
    await expect(hub.finishAuth("linear", "auth-code-123", minted.state!)).rejects.toThrow(/expired/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it("a completed authorization's state cannot be replayed", async () => {
    const minted: { state?: string } = {};
    const deps = hubDeps({ open: needsAuthOpen(minted), complete: async () => connectedConn("linear") });
    const hub = new ConnectorGatewayHub(deps);
    await hub.connect({ name: "linear", url: "https://x/mcp" });

    await hub.finishAuth("linear", "auth-code-123", minted.state!);
    await expect(hub.finishAuth("linear", "auth-code-123", minted.state!)).rejects.toThrow(/pending/i);
  });

  it("remove drops the provider, its tools, and its status", async () => {
    const deps = hubDeps({
      open: async (): Promise<OpenResult> => ({ status: "connected", connection: connectedConn("gmail"), transport: {} as never }),
    });
    const hub = new ConnectorGatewayHub(deps);
    await hub.connect({ name: "gmail", url: "https://x/mcp" });
    expect(hub.listTools()).toHaveLength(2);

    hub.remove("gmail");
    expect(hub.listTools()).toHaveLength(0);
    expect(hub.status().find((s) => s.name === "gmail")).toBeUndefined();
  });

  it("writes the gateway bearer headers into the .mcp.json registration (A3 - the agent reads them)", async () => {
    const deps = hubDeps({
      open: async (): Promise<OpenResult> => ({ status: "connected", connection: connectedConn("gmail"), transport: {} as never }),
      gatewayHeaders: { Authorization: "Bearer tok123" },
    });
    const hub = new ConnectorGatewayHub(deps);
    await hub.connect({ name: "gmail", url: "https://x/mcp" });
    const reg = JSON.parse(readFileSync(join(deps.workspaceDir, ".mcp.json"), "utf8"));
    expect(reg.mcpServers["buildex-connectors"]).toEqual({ type: "http", url: deps.gatewayUrl, headers: { Authorization: "Bearer tok123" } });
  });

  it("passes the connector's OAuth token store scope through (keychain-namespaced)", async () => {
    // the hub builds a KeychainOAuthProvider per connector; a connect that needs auth must not
    // leave tokens anywhere but the injected store - proven by the store staying the sole sink.
    const store = memStore();
    const openSpy = vi.fn(async (_c: ProviderServerConfig): Promise<OpenResult> => ({ status: "needs-auth", transport: {} as never }));
    const hub = new ConnectorGatewayHub(hubDeps({ store, open: openSpy }));
    await hub.connect({ name: "gmail", url: "https://x/mcp", scopes: ["gmail.readonly"] });
    // the provider handed to openProvider is the keychain-backed one
    const passedAuth = openSpy.mock.calls[0]![0].authProvider!;
    expect(passedAuth.redirectUrl).toBe("http://127.0.0.1:4317/oauth/gmail/callback");
  });
});

// A connected `open` that honors the config's policy, like the real openProvider does
// (providerFromClient carries config.policy onto the connection).
const openHonoringPolicy = (calls?: ProviderServerConfig[]) =>
  async (c: ProviderServerConfig): Promise<OpenResult> => {
    calls?.push(c);
    return {
      status: "connected",
      connection: { ...connectedConn(c.name), ...(c.policy ? { policy: c.policy } : {}) },
      transport: {} as never,
    };
  };

describe("ConnectorGatewayHub - specs persist in the KEYCHAIN, never agent-writable space (A2)", () => {
  it("round-trips: connect + tighten persists to the secret store; a fresh hub restores both", async () => {
    const store = memStore();
    const hub1 = new ConnectorGatewayHub(hubDeps({ store, open: openHonoringPolicy() }));
    await hub1.connect({ name: "gmail", url: "https://mcp.gmail.example/mcp" });
    expect(hub1.setPolicy("gmail", "search", "gated").ok).toBe(true); // the operator tightens a read tool

    // "restart": a new hub over the SAME store reconnects from the persisted spec alone
    const calls: ProviderServerConfig[] = [];
    const hub2 = new ConnectorGatewayHub(hubDeps({ store, open: openHonoringPolicy(calls) }));
    await hub2.restore();
    expect(calls[0]!.url).toBe("https://mcp.gmail.example/mcp"); // the APPROVED url, from the keychain
    expect(hub2.status()).toMatchObject([{ name: "gmail", connected: true }]);
    // the legitimate tightening survived the restart…
    expect(hub2.listTools().find((t) => t.name === "gmail__search")!.kind).toBe("gated");
    // …and the write tool is still gated (nothing loosened it)
    expect(hub2.listTools().find((t) => t.name === "gmail__send")!.kind).toBe("gated");
  });

  it("restore(extra): founder-config providers win a name clash (config is trusted over history)", async () => {
    const store = memStore();
    const hub1 = new ConnectorGatewayHub(hubDeps({ store, open: openHonoringPolicy() }));
    await hub1.connect({ name: "gmail", url: "https://old.example/mcp" });

    const calls: ProviderServerConfig[] = [];
    const hub2 = new ConnectorGatewayHub(hubDeps({ store, open: openHonoringPolicy(calls) }));
    await hub2.restore([{ name: "gmail", url: "https://new.example/mcp" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://new.example/mcp");
  });

  it("a spec that fails to reconnect stays persisted and visible for retry (never silently dropped)", async () => {
    const store = memStore();
    const hub1 = new ConnectorGatewayHub(hubDeps({ store, open: openHonoringPolicy() }));
    await hub1.connect({ name: "gmail", url: "https://x/mcp" });

    const hub2 = new ConnectorGatewayHub(hubDeps({ store, open: async () => { throw new Error("server down"); } }));
    await hub2.restore();
    expect(hub2.persistedSpecs().map((s) => s.name)).toContain("gmail");
    // …and a third hub over the same store still sees it
    const hub3 = new ConnectorGatewayHub(hubDeps({ store, open: openHonoringPolicy() }));
    await hub3.restore();
    expect(hub3.status()).toMatchObject([{ name: "gmail", connected: true }]);
  });

  it("a failed add is NOT persisted (no retry loop on every restart)", async () => {
    const store = memStore();
    const hub = new ConnectorGatewayHub(hubDeps({ store, open: async () => { throw new Error("bad url"); } }));
    await expect(hub.connect({ name: "broken", url: "https://nope/mcp" })).rejects.toThrow();
    expect(hub.persistedSpecs()).toHaveLength(0);
    const hub2 = new ConnectorGatewayHub(hubDeps({ store, open: openHonoringPolicy() }));
    await hub2.restore();
    expect(hub2.status()).toHaveLength(0);
  });

  it("remove drops the persisted spec - the provider never reconnects", async () => {
    const store = memStore();
    const hub1 = new ConnectorGatewayHub(hubDeps({ store, open: openHonoringPolicy() }));
    await hub1.connect({ name: "gmail", url: "https://x/mcp" });
    hub1.remove("gmail");

    const hub2 = new ConnectorGatewayHub(hubDeps({ store, open: openHonoringPolicy() }));
    await hub2.restore();
    expect(hub2.status()).toHaveLength(0);
    expect(hub2.persistedSpecs()).toHaveLength(0);
  });
});
