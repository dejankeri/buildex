import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { providerFromClient } from "./mcp-client.js";
import { classifyTool, ConnectorGateway } from "./gateway.js";

// A hermetic stand-in provider MCP server (what Gmail/Notion/etc. expose over the wire in prod).
async function fakeProviderClient(): Promise<Client> {
  const server = new McpServer({ name: "fake-gmail", version: "1.0.0" });
  server.registerTool(
    "search",
    { description: "Search mail", inputSchema: { q: z.string() }, annotations: { readOnlyHint: true } },
    async ({ q }) => ({ content: [{ type: "text", text: `hits for ${q}` }] }),
  );
  server.registerTool(
    "send",
    { description: "Send mail", inputSchema: { to: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true } },
    async () => ({ content: [{ type: "text", text: "sent" }] }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "buildex-gateway", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("providerFromClient", () => {
  it("lists the provider's tools and preserves read-only annotations", async () => {
    const conn = await providerFromClient("gmail", await fakeProviderClient());
    expect(conn.name).toBe("gmail");
    const search = conn.tools.find((t) => t.name === "search")!;
    const send = conn.tools.find((t) => t.name === "send")!;
    expect(search.annotations?.readOnlyHint).toBe(true);
    // classification (the safety story) survives the round-trip through the SDK
    expect(classifyTool(search)).toBe("read");
    expect(classifyTool(send)).toBe("gated");
  });

  it("calls a tool through the live client and normalizes the result", async () => {
    const conn = await providerFromClient("gmail", await fakeProviderClient());
    const res = await conn.call("search", { q: "invoices" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toBe("hits for invoices");
  });

  it("plugs into the gateway end-to-end: read passes, send is gated", async () => {
    let approvals = 0;
    const g = new ConnectorGateway({ approve: async () => { approvals++; return { approved: true }; } });
    g.register(await providerFromClient("gmail", await fakeProviderClient()));

    const r1 = await g.callTool("gmail__search", { q: "x" });
    expect(r1.content[0]!.text).toBe("hits for x");
    expect(approvals).toBe(0);

    const r2 = await g.callTool("gmail__send", { to: "a@b.co" });
    expect(r2.content[0]!.text).toBe("sent");
    expect(approvals).toBe(1); // the human tap happened before the send
  });
});
