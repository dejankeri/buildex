// The connector MCP gateway - the load-bearing safety piece of the OAuth+MCP connectors.
//
// buildex exposes ONE local MCP server (registered per-workspace in the agent's config - the blessed
// local-MCP seam) that proxies to provider MCP servers. This module is the transport-free CORE: given a set
// of provider tools, it decides which are safe to pass straight to the agent (reads) and which must
// wait for a human tap (writes/sends), preserving invariant 5 ("nothing outward without a human").
//
// The rule is DEFAULT-DENY: a tool is gated unless it proves itself read-only (MCP's own
// `readOnlyHint`) or a connector policy explicitly allows it. Reads execute live; gated calls go
// through the injected approver (→ the Pending tray) and only run if a human approves.

/** A provider tool as the gateway sees it (mirrors the MCP tool shape we depend on). */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export type ToolKind = "read" | "gated";
/** Effective state on the operator's trust surface - like ToolKind, plus "hidden". */
export type ToolState = "read" | "gated" | "hidden";

/** Per-connector overrides on the default-deny classifier. */
export interface ConnectorPolicy {
  /** Tool names to expose as read pass-through even without a readOnlyHint. */
  read?: string[];
  /** Tool names to force through the gate even if they claim to be read-only. */
  gated?: string[];
  /** Tool names to hide from the agent entirely. */
  hidden?: string[];
}

/** The MCP tool-result shape the gateway returns to the agent. */
export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** A human-in-the-loop decision on a gated (outward) tool call. */
export interface ApprovalRequest {
  connector: string;
  tool: string;
  args: unknown;
  summary: string;
}
export interface Approver {
  approve(req: ApprovalRequest): Promise<{ approved: boolean; reason?: string }>;
}

/** One connected provider: its tools, its policy, and how to actually call it (SDK client injected). */
export interface ProviderConnection {
  name: string;
  tools: McpTool[];
  policy?: ConnectorPolicy;
  call(tool: string, args: unknown): Promise<McpToolResult>;
}

export interface GatewayToolInfo {
  name: string; // qualified: <connector>__<tool>
  description?: string;
  inputSchema?: unknown;
  kind: ToolKind;
}

/** One tool as the operator's MCP editor sees it - includes hidden tools and the intrinsic baseline
 *  so the UI can offer only tighten-only transitions (never removing the human gate). */
export interface GatewayInventoryItem {
  name: string; // qualified: <connector>__<tool>
  connector: string;
  tool: string; // bare tool name
  description?: string;
  /** Effective state, override applied. */
  kind: ToolState;
  /** Intrinsic classification (readOnlyHint only, no override) - the floor the operator can't go below. */
  baseline: ToolKind;
}

/** Decide whether a tool is a safe read pass-through or must wait for a human. Default: gated. */
export function classifyTool(tool: McpTool, policy?: ConnectorPolicy): ToolKind {
  if (policy?.gated?.includes(tool.name)) return "gated"; // the gate always wins
  if (policy?.read?.includes(tool.name)) return "read";
  if (tool.annotations?.readOnlyHint === true) return "read";
  return "gated";
}

const SEP = "__";

export class ConnectorGateway {
  private readonly conns = new Map<string, ProviderConnection>();
  constructor(private readonly deps: { approve: Approver["approve"] }) {}

  register(conn: ProviderConnection): void {
    this.conns.set(conn.name, conn);
  }

  /** Drop a provider - its tools disappear from the agent's surface. Idempotent. */
  unregister(name: string): void {
    this.conns.delete(name);
  }

  has(name: string): boolean {
    return this.conns.has(name);
  }

  /** Every non-hidden tool, namespaced and tagged with its kind - what the agent's MCP client sees. */
  listTools(): GatewayToolInfo[] {
    const out: GatewayToolInfo[] = [];
    for (const conn of this.conns.values()) {
      for (const t of conn.tools) {
        if (conn.policy?.hidden?.includes(t.name)) continue;
        out.push({
          name: `${conn.name}${SEP}${t.name}`,
          ...(t.description ? { description: t.description } : {}),
          ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
          kind: classifyTool(t, conn.policy),
        });
      }
    }
    return out;
  }

  /** Every tool including hidden, tagged with effective state + intrinsic baseline - the operator's
   *  trust/editor surface (distinct from listTools, which is the agent's surface and drops hidden). */
  listInventory(): GatewayInventoryItem[] {
    const out: GatewayInventoryItem[] = [];
    for (const conn of this.conns.values()) {
      for (const t of conn.tools) {
        const hidden = conn.policy?.hidden?.includes(t.name) ?? false;
        out.push({
          name: `${conn.name}${SEP}${t.name}`,
          connector: conn.name,
          tool: t.name,
          ...(t.description ? { description: t.description } : {}),
          kind: hidden ? "hidden" : classifyTool(t, conn.policy),
          baseline: classifyTool(t, {}), // readOnlyHint only - the floor
        });
      }
    }
    return out;
  }

  /** Reclassify one tool, TIGHTEN-ONLY: read→gated/hidden and restore are allowed, but an outward
   *  (baseline-gated) tool can NEVER be promoted to read - the human gate is add-only (invariant 5).
   *  Returns the new connector policy so the caller can persist it. Never throws. */
  setToolPolicy(connName: string, toolName: string, target: ToolState): { ok: boolean; reason?: string; policy?: ConnectorPolicy } {
    const conn = this.conns.get(connName);
    if (!conn) return { ok: false, reason: `unknown connector: ${connName}` };
    const tool = conn.tools.find((t) => t.name === toolName);
    if (!tool) return { ok: false, reason: `unknown tool: ${toolName}` };
    const baseline = classifyTool(tool, {});
    if (target === "read" && baseline !== "read") {
      return { ok: false, reason: "the human gate can't be removed from an outward tool" };
    }
    // Start from the current policy, strip this tool from every list, then record only a real override
    // (restoring a tool to its baseline leaves it out of all lists).
    const strip = (arr?: string[]) => (arr ?? []).filter((n) => n !== toolName);
    const next: ConnectorPolicy = { read: strip(conn.policy?.read), gated: strip(conn.policy?.gated), hidden: strip(conn.policy?.hidden) };
    if (target === "hidden") next.hidden!.push(toolName);
    else if (target === "gated" && baseline !== "gated") next.gated!.push(toolName);
    else if (target === "read" && baseline !== "read") next.read!.push(toolName); // unreachable (guarded above)
    conn.policy = normalizePolicy(next);
    return { ok: true, policy: conn.policy };
  }

  /** Route a tool call: reads execute live; gated calls wait for a human. Never throws. */
  async callTool(qualified: string, args: unknown): Promise<McpToolResult> {
    const idx = qualified.indexOf(SEP);
    if (idx < 0) return err(`unknown tool: ${qualified}`);
    const connName = qualified.slice(0, idx);
    const toolName = qualified.slice(idx + SEP.length);

    const conn = this.conns.get(connName);
    if (!conn) return err(`unknown connector: ${connName}`);
    const tool = conn.tools.find((t) => t.name === toolName);
    if (!tool || conn.policy?.hidden?.includes(toolName)) return err(`unknown tool: ${qualified}`);

    if (classifyTool(tool, conn.policy) === "gated") {
      let decision: { approved: boolean; reason?: string };
      try {
        decision = await this.deps.approve({ connector: connName, tool: toolName, args, summary: summarize(connName, toolName, args) });
      } catch (e) {
        return err(`approval failed for ${qualified}`);
      }
      if (!decision.approved) return err(`declined by human${decision.reason ? `: ${decision.reason}` : ""}`);
    }

    try {
      return await conn.call(toolName, args);
    } catch (e) {
      return err(`${qualified} failed`);
    }
  }
}

/** Drop empty override lists so a persisted policy stays minimal (and equals {} when nothing is set). */
function normalizePolicy(p: ConnectorPolicy): ConnectorPolicy {
  const out: ConnectorPolicy = {};
  if (p.read?.length) out.read = p.read;
  if (p.gated?.length) out.gated = p.gated;
  if (p.hidden?.length) out.hidden = p.hidden;
  return out;
}

function summarize(connector: string, tool: string, args: unknown): string {
  let a = "";
  try {
    a = JSON.stringify(args);
    if (a.length > 200) a = a.slice(0, 197) + "…";
  } catch {
    a = "(unserializable args)";
  }
  return `${connector} · ${tool} ${a}`;
}

function err(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
