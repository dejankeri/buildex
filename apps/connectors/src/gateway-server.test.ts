import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConnectorGateway, type ProviderConnection } from "./gateway.js";
import { createGatewayServer } from "./gateway-server.js";

function fakeProvider(call = vi.fn(async (tool: string) => ({ content: [{ type: "text" as const, text: `ran ${tool}` }] }))): ProviderConnection {
  return {
    name: "gmail",
    tools: [
      { name: "search", description: "Search mail", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
      { name: "send", description: "Send mail", annotations: { readOnlyHint: false } },
    ],
    call,
  };
}

// Connect a client to BuildEx's gateway server exactly as the operator's agent would.
async function agentClient(gateway: ConnectorGateway): Promise<Client> {
  const server = createGatewayServer(gateway);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "agent", version: "1.0.0" });
  await client.connect(clientT);
  return client;
}

describe("createGatewayServer - the agent-facing MCP surface", () => {
  it("advertises namespaced tools with the provider's schema and a read-only hint per kind", async () => {
    const g = new ConnectorGateway({ approve: async () => ({ approved: true }) });
    g.register(fakeProvider());
    const client = await agentClient(g);

    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "gmail__search")!;
    const send = tools.find((t) => t.name === "gmail__send")!;
    expect(search.inputSchema).toMatchObject({ type: "object", properties: { q: { type: "string" } } });
    expect(search.annotations?.readOnlyHint).toBe(true);
    expect(send.annotations?.readOnlyHint).toBe(false); // gated
    expect(send.description).toMatch(/approval/i);
  });

  it("executes a read tool the agent calls, without a human tap", async () => {
    const call = vi.fn(async (tool: string) => ({ content: [{ type: "text" as const, text: `ran ${tool}` }] }));
    const approve = vi.fn(async () => ({ approved: true }));
    const g = new ConnectorGateway({ approve });
    g.register(fakeProvider(call));
    const client = await agentClient(g);

    const res = await client.callTool({ name: "gmail__search", arguments: { q: "x" } });
    expect((res.content as { text: string }[])[0]!.text).toBe("ran search");
    expect(approve).not.toHaveBeenCalled();
  });

  it("makes the agent's send wait for a human, and reports the decline as a tool error", async () => {
    const call = vi.fn(async (tool: string) => ({ content: [{ type: "text" as const, text: `ran ${tool}` }] }));
    const approve = vi.fn(async () => ({ approved: false, reason: "later" }));
    const g = new ConnectorGateway({ approve });
    g.register(fakeProvider(call));
    const client = await agentClient(g);

    const res = await client.callTool({ name: "gmail__send", arguments: { to: "a@b.co" } });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(/declined|later/i);
  });
});
