// The connector MCP gateway - the classifier for the OAuth+MCP connectors.
//
// buildex exposes ONE local MCP server (registered per-workspace in the agent's config - the blessed
// local-MCP seam) that proxies to provider MCP servers. This module is the transport-free CORE: given a set
// of provider tools, it decides which run autonomously and which wait for a human tap - the revised
// invariant 5 ("wide autonomy, few gates").
//
// The rule is DEFAULT PASS-THROUGH: a tool runs autonomously unless it reads as business-important -
// money, outbound-to-real-people, publishing, or irreversible destruction (MCP's own `destructiveHint`
// or an outward-intent name), or a connector policy explicitly gates it. Gated calls go through the
// injected approver (→ inline in chat / the company surface) and only run if a human approves. The
// operator can tighten OR widen any tool (setToolPolicy); every outward call is logged regardless.

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

/** Per-connector overrides on the intent-based classifier. */
export interface ConnectorPolicy {
  /** Tool names to run autonomously (read pass-through) even if they'd otherwise gate by intent. */
  read?: string[];
  /** Tool names to force through the gate even if they'd otherwise run autonomously. */
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

// Tool names that read as fetching/inspecting, never acting - kept autonomous even if they happen to
// contain an outward token (e.g. `get_message_count`, `list_invoices`). Matched as a leading verb.
const READ_PREFIX = /^(get|list|search|find|read|fetch|count|lookup|show|view|describe|query|browse)([_\-]|[A-Z]|$)/i;

// Business-important intents that stay gated even at wide-open defaults: money, outbound-to-real-
// people, publishing, and irreversible destruction. Matched as a whole token (word start / camelCase
// hump) so `send`/`sendMessage`/`create_charge`/`publish-post` gate but `search`/`created_at` don't.
const OUTWARD_INTENT =
  /(^|[_\-])(send|message|msg|email|mail|sms|dm|notify|post|publish|share|charge|refund|payout|invoice|delete|remove|destroy|cancel|archive|revoke)([_\-]|[A-Z]|$)/i;

/** Decide whether a tool runs autonomously (read) or must wait for a human (gated). Default: read.
 *  Gate only money / outbound-to-people / publishing / destruction - by explicit policy, MCP's
 *  destructiveHint, or an outward-intent name. Operator overrides (policy.read / policy.gated) win. */
export function classifyTool(tool: McpTool, policy?: ConnectorPolicy): ToolKind {
  if (policy?.gated?.includes(tool.name)) return "gated"; // explicit operator/pack gate wins
  if (policy?.read?.includes(tool.name)) return "read"; // explicit operator widen (owns the risk)
  if (tool.annotations?.destructiveHint === true) return "gated"; // provider says it's destructive
  if (tool.annotations?.readOnlyHint === true) return "read"; // provider asserts no side effects
  if (READ_PREFIX.test(tool.name)) return "read"; // a fetch/inspect verb - autonomous
  if (OUTWARD_INTENT.test(tool.name)) return "gated"; // money / outbound / publish / destroy
  return "read"; // wide by default
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

  /** Reclassify one tool, OPERATOR-ADJUSTABLE both ways: read↔gated↔hidden. Under the revised
   *  invariant 5 the operator may widen an outward tool to run autonomously (they own the risk) as
   *  well as tighten a read tool to the gate - autonomy is configured, not add-only. Every outward
   *  call is logged on the company activity surface regardless. Returns the new connector policy so
   *  the caller can persist it. Never throws. */
  setToolPolicy(connName: string, toolName: string, target: ToolState): { ok: boolean; reason?: string; policy?: ConnectorPolicy } {
    const conn = this.conns.get(connName);
    if (!conn) return { ok: false, reason: `unknown connector: ${connName}` };
    const tool = conn.tools.find((t) => t.name === toolName);
    if (!tool) return { ok: false, reason: `unknown tool: ${toolName}` };
    const baseline = classifyTool(tool, {});
    // Start from the current policy, strip this tool from every list, then record only a real override
    // (restoring a tool to its baseline leaves it out of all lists).
    const strip = (arr?: string[]) => (arr ?? []).filter((n) => n !== toolName);
    const next: ConnectorPolicy = { read: strip(conn.policy?.read), gated: strip(conn.policy?.gated), hidden: strip(conn.policy?.hidden) };
    if (target === "hidden") next.hidden!.push(toolName);
    else if (target === "gated" && baseline !== "gated") next.gated!.push(toolName);
    else if (target === "read" && baseline !== "read") next.read!.push(toolName);
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
