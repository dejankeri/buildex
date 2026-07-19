// Per-workspace gateway registration - writes the `.mcp.json` that makes the operator's agent
// connect to BuildEx's local gateway MCP server. This is exactly the blessed local-MCP seam ("local MCP servers
// registered per workspace… versioned in the workspace"): the entry points at the daemon's loopback
// endpoint, holds no secret (OAuth tokens live in the keychain), and merges non-destructively so it
// never clobbers MCP servers the operator configured themselves.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GATEWAY_SERVER_KEY = "buildex-connectors";

export interface GatewayRegistration {
  /** The daemon's gateway MCP endpoint (loopback streamable HTTP). */
  url: string;
  /** Headers the agent's MCP client must send - carries the daemon-minted gateway bearer token (A3).
   *  Machine-local (the workspace-root .mcp.json is never synced) and not a provider credential:
   *  it only proves a request came from something that can read the operator's local files. */
  headers?: Record<string, string>;
}

interface McpJson {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

export const PACK_KEY_PREFIX = "buildex-pack:";

export type McpServerConfig =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

/** Merge/remove many named entries in one pass. `entries[key]===null` removes that key; every other
 *  existing key (the gateway key, operator-configured servers) is preserved untouched. This is the
 *  generalized form behind both the gateway registration and pack MCP pinning. */
export function renderMcpEntries(
  existing: string | undefined,
  entries: Record<string, McpServerConfig | null>,
): string {
  let doc: McpJson = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object") doc = parsed as McpJson;
    } catch {
      doc = {};
    }
  }
  const servers: Record<string, unknown> = { ...(doc.mcpServers ?? {}) };
  for (const [key, cfg] of Object.entries(entries)) {
    if (cfg) servers[key] = cfg;
    else delete servers[key];
  }
  return JSON.stringify({ ...doc, mcpServers: servers }, null, 2) + "\n";
}

/** Write/update .mcp.json at the workspace root with many entries; returns the path. */
export function writeMcpEntries(workspaceDir: string, entries: Record<string, McpServerConfig | null>): string {
  const path = join(workspaceDir, ".mcp.json");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  writeFileSync(path, renderMcpEntries(existing, entries));
  return path;
}

/** Merge (or remove, when reg is null) BuildEx's gateway entry into an existing .mcp.json string. */
export function renderMcpJson(existing: string | undefined, reg: GatewayRegistration | null): string {
  return renderMcpEntries(existing, {
    [GATEWAY_SERVER_KEY]: reg ? { type: "http", url: reg.url, ...(reg.headers ? { headers: reg.headers } : {}) } : null,
  });
}

/** Write/update .mcp.json at the workspace root; returns the path. */
export function writeGatewayRegistration(workspaceDir: string, reg: GatewayRegistration): string {
  const path = join(workspaceDir, ".mcp.json");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  writeFileSync(path, renderMcpJson(existing, reg));
  return path;
}

/** Drop BuildEx's gateway entry, leaving any operator-configured servers intact. */
export function removeGatewayRegistration(workspaceDir: string): void {
  const path = join(workspaceDir, ".mcp.json");
  if (!existsSync(path)) return;
  writeFileSync(path, renderMcpJson(readFileSync(path, "utf8"), null));
}
