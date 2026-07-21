// The buildex gateway MCP server - the single local MCP server buildex registers into the operator's agent
// config (per-workspace, the blessed local-MCP seam). It's a passthrough proxy: it advertises the gateway's
// namespaced tools with the provider's own JSON Schema, and forwards each call to ConnectorGateway,
// which passes reads straight through and routes writes/sends through the human gate.
//
// Built on the low-level Server (not McpServer) so schemas and arguments pass through verbatim - a
// proxy has no business re-deriving a Zod shape from the provider's JSON Schema.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorGateway } from "./gateway.js";

export function createGatewayServer(
  gateway: ConnectorGateway,
  info?: { name?: string; version?: string },
): Server {
  const server = new Server(
    { name: info?.name ?? "buildex-connectors", version: info?.version ?? "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: gateway.listTools().map((t) => ({
      name: t.name,
      description:
        (t.description ?? t.name) +
        (t.kind === "gated"
          ? t.conditional
            ? " - some actions need human approval (outward action; waits in the Pending tray)"
            : " - needs human approval (outward action; waits in the Pending tray)"
          : ""),
      inputSchema: (t.inputSchema as { type: "object" } | undefined) ?? { type: "object" as const },
      annotations: { readOnlyHint: t.kind === "read" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await gateway.callTool(req.params.name, req.params.arguments ?? {});
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  });

  return server;
}
