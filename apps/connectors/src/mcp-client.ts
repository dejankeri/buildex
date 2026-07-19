// Provider MCP client - turns a connected MCP SDK Client (talking to Gmail/Notion/Slack/… over the
// wire) into the transport-free ProviderConnection the gateway routes through. Transport + OAuth are
// constructed by the caller (see mcp-transport.ts) and injected here as an already-connected Client,
// so this stays hermetically testable against an in-memory server.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ConnectorPolicy, McpTool, McpToolResult, ProviderConnection } from "./gateway.js";

/** List a connected provider's tools and wrap tool calls into a ProviderConnection. */
export async function providerFromClient(
  name: string,
  client: Client,
  policy?: ConnectorPolicy,
): Promise<ProviderConnection> {
  const listed = await client.listTools();
  const tools: McpTool[] = listed.tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
    ...(t.annotations ? { annotations: t.annotations as McpTool["annotations"] } : {}),
  }));
  return {
    name,
    tools,
    ...(policy ? { policy } : {}),
    async call(tool: string, args: unknown): Promise<McpToolResult> {
      const res = await client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> });
      return normalize(res as unknown as { content?: unknown; isError?: boolean });
    },
  };
}

/** Flatten an SDK CallToolResult into the gateway's text-only result shape. */
function normalize(res: { content?: unknown; isError?: boolean }): McpToolResult {
  const raw = Array.isArray(res.content) ? res.content : [];
  const content = raw.map((c) => {
    const item = c as { type?: string; text?: string };
    return { type: "text" as const, text: item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(c) };
  });
  return {
    content: content.length ? content : [{ type: "text", text: "" }],
    ...(res.isError ? { isError: true } : {}),
  };
}
