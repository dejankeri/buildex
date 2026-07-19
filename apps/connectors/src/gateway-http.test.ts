import { describe, it, expect, afterEach, vi } from "vitest";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConnectorGateway, type ProviderConnection } from "./gateway.js";
import { startGatewayHttp, type GatewayHttp } from "./gateway-http.js";

const TOKEN = "test-gateway-token";

function provider(call = vi.fn(async (tool: string) => ({ content: [{ type: "text" as const, text: `ran ${tool}` }] }))): ProviderConnection {
  return {
    name: "gmail",
    tools: [
      { name: "search", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
      { name: "send", annotations: { readOnlyHint: false } },
    ],
    call,
  };
}

/** Raw HTTP POST to /mcp - lets tests set Host/Origin headers fetch() forbids. */
function raw(port: number, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body ?? "{}");
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

let host: GatewayHttp | undefined;
afterEach(async () => {
  if (host) await host.close();
  host = undefined;
});

async function startHost(): Promise<GatewayHttp> {
  const gateway = new ConnectorGateway({ approve: async () => ({ approved: true }) });
  gateway.register(provider());
  host = await startGatewayHttp(gateway, { token: TOKEN });
  return host;
}

describe("startGatewayHttp - the gateway is reachable over real HTTP (what the agent uses)", () => {
  it("serves listTools + read/gated callTool over a live loopback round-trip with the bearer token", async () => {
    const call = vi.fn(async (tool: string) => ({ content: [{ type: "text" as const, text: `ran ${tool}` }] }));
    const approve = vi.fn(async () => ({ approved: true }));
    const gateway = new ConnectorGateway({ approve });
    gateway.register(provider(call));

    host = await startGatewayHttp(gateway, { token: TOKEN });
    // The agent's registered client: it reads url + headers from .mcp.json and sends no Origin.
    const client = new Client({ name: "agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }),
    );

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["gmail__search", "gmail__send"]);

    const readRes = await client.callTool({ name: "gmail__search", arguments: { q: "x" } });
    expect((readRes.content as { text: string }[])[0]!.text).toBe("ran search");
    expect(approve).not.toHaveBeenCalled();

    const gatedRes = await client.callTool({ name: "gmail__send", arguments: { to: "a@b.co" } });
    expect(approve).toHaveBeenCalledTimes(1); // the human tap happened, over HTTP
    expect((gatedRes.content as { text: string }[])[0]!.text).toBe("ran send");

    await client.close();
  });

  it("rejects an unauthenticated request with 401 (missing token)", async () => {
    const h = await startHost();
    expect(await raw(h.port, {}, INITIALIZE)).toBe(401);
  });

  it("rejects a wrong bearer token with 401", async () => {
    const h = await startHost();
    expect(await raw(h.port, { authorization: "Bearer wrong-token" }, INITIALIZE)).toBe(401);
  });

  it("rejects a foreign Origin with 403 even when the token is valid (cross-origin browser fetch)", async () => {
    const h = await startHost();
    expect(await raw(h.port, { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" }, INITIALIZE)).toBe(403);
    expect(await raw(h.port, { authorization: `Bearer ${TOKEN}`, origin: "null" }, INITIALIZE)).toBe(403);
  });

  it("rejects a non-loopback Host with 403 even when the token is valid (DNS rebinding)", async () => {
    const h = await startHost();
    expect(await raw(h.port, { authorization: `Bearer ${TOKEN}`, host: "attacker.example" }, INITIALIZE)).toBe(403);
    expect(await raw(h.port, { authorization: `Bearer ${TOKEN}`, host: `attacker.example:${h.port}` }, INITIALIZE)).toBe(403);
  });

  it("accepts a loopback Origin + valid token (the console's own browser context)", async () => {
    const h = await startHost();
    expect(await raw(h.port, { authorization: `Bearer ${TOKEN}`, origin: `http://localhost:${h.port}` }, INITIALIZE)).toBe(200);
    expect(await raw(h.port, { authorization: `Bearer ${TOKEN}`, origin: "http://127.0.0.1:4317" }, INITIALIZE)).toBe(200);
  });
});
