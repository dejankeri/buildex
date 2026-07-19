import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { openProvider } from "./mcp-transport.js";

async function linkedToFakeServer(): Promise<Transport> {
  const server = new McpServer({ name: "fake-notion", version: "1.0.0" });
  server.registerTool(
    "get_page",
    { description: "Read a page", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => ({ content: [{ type: "text", text: `page ${id}` }] }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

// A transport whose start() fails as if the server demanded OAuth.
function unauthorizedTransport(): Transport {
  return {
    async start() {
      throw new UnauthorizedError("needs auth");
    },
    async send() {},
    async close() {},
  } as unknown as Transport;
}

describe("openProvider", () => {
  it("connects through the transport and returns a live ProviderConnection", async () => {
    const clientTransport = await linkedToFakeServer();
    const res = await openProvider(
      { name: "notion", url: "https://mcp.notion.example/mcp" },
      { makeTransport: () => clientTransport },
    );
    expect(res.status).toBe("connected");
    if (res.status !== "connected") throw new Error("unreachable");
    const tool = res.connection.tools.find((t) => t.name === "get_page")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect((await res.connection.call("get_page", { id: "abc" })).content[0]!.text).toBe("page abc");
  });

  it("reports needs-auth (not a raw throw) when the server demands OAuth", async () => {
    const res = await openProvider(
      { name: "notion", url: "https://mcp.notion.example/mcp" },
      { makeTransport: () => unauthorizedTransport() },
    );
    expect(res.status).toBe("needs-auth");
    expect(res.transport).toBeDefined(); // caller finishes auth on this transport, then reopens
  });
});
