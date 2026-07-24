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
// operator can tighten OR widen any tool (setToolPolicy). The gateway itself is daemon-agnostic and
// records nothing: gating decisions surface through the client's approval broker, where the company
// activity ledger writes one line per resolution (a tool widened to run autonomously is routine
// work, which the ledger deliberately does not carry).

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

/** A policy entry that fires only when the CALL's arguments carry particular values.
 *
 *  Name-based classification assumes one tool = one intent, which intent-verb MCP servers break: a
 *  single fat `schedule` verb both books an appointment (routine) and fires a reminder at a real
 *  person (outward), decided by its `action` argument. Gating the whole verb would put every routine
 *  booking behind a tap; leaving it open lets messages out unattended. A rule says "gate this verb,
 *  but only for these actions". */
export interface ToolRule {
  tool: string;
  /** Argument name → values that trigger the rule. Args are ANDed, values within one arg ORed.
   *  Absent or empty `when` makes the rule unconditional - identical to the bare-string form. */
  when?: Record<string, (string | number | boolean)[]>;
}
/** A bare tool name (always matches) or an argument-conditional rule. */
export type PolicyEntry = string | ToolRule;

/** Per-connector overrides on the intent-based classifier. */
export interface ConnectorPolicy {
  /** Tools to run autonomously (read pass-through) even if they'd otherwise gate by intent. */
  read?: PolicyEntry[];
  /** Tools to force through the gate even if they'd otherwise run autonomously. */
  gated?: PolicyEntry[];
  /** Tool names to hide from the agent entirely. Unconditional by construction - a tool is either in
   *  the agent's list or not, and that decision is made before any call (and so any args) exists. */
  hidden?: string[];
}

/** The tool a policy entry is about. */
export function entryTool(e: PolicyEntry): string {
  return typeof e === "string" ? e : e.tool;
}

/** Whether an entry carries an argument condition (vs. always applying). */
function isConditional(e: PolicyEntry): e is ToolRule {
  return typeof e !== "string" && !!e.when && Object.keys(e.when).length > 0;
}

/** Does this entry apply to this call? `whenUnknown` is the answer for a conditional rule whose args
 *  can't be inspected - callers pass the SAFE direction: true when matching would gate (fail closed),
 *  false when matching would widen to autonomous (also fail closed). */
function entryApplies(e: PolicyEntry, args: unknown, whenUnknown: boolean): boolean {
  if (!isConditional(e)) return true;
  if (typeof args !== "object" || args === null) return whenUnknown;
  const a = args as Record<string, unknown>;
  return Object.entries(e.when!).every(([k, vals]) => vals.some((v) => a[k] === v));
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
  /** The OPERATOR's overrides - what `setToolPolicy` writes and the hub persists to the keychain. */
  policy?: ConnectorPolicy;
  /** The pack-shipped baseline, refreshed from the catalog on every sync rather than persisted, so a
   *  pack that TIGHTENS a gate (a security fix) reaches providers that are already connected. Trusted
   *  at the same level as app code: it comes from the bundled catalog, not the operator's workspace. */
  basePolicy?: ConnectorPolicy;
  call(tool: string, args: unknown): Promise<McpToolResult>;
}

export interface GatewayToolInfo {
  name: string; // qualified: <connector>__<tool>
  description?: string;
  inputSchema?: unknown;
  kind: ToolKind;
  /** Set when `kind` is "gated" only for certain argument values (see ToolRule). */
  conditional?: boolean;
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

/** The classification a tool carries on its own, before any policy: MCP's own hints, then intent read
 *  from the name. This is the floor `setToolPolicy` measures overrides against. */
function intrinsicKind(tool: McpTool): ToolKind {
  if (tool.annotations?.destructiveHint === true) return "gated"; // provider says it's destructive
  if (tool.annotations?.readOnlyHint === true) return "read"; // provider asserts no side effects
  if (READ_PREFIX.test(tool.name)) return "read"; // a fetch/inspect verb - autonomous
  if (OUTWARD_INTENT.test(tool.name)) return "gated"; // money / outbound / publish / destroy
  return "read"; // wide by default
}

/** What one policy layer says about this call, or undefined if it says nothing. Gates are considered
 *  before widenings, so a layer that both gates and widens a tool gates it. */
function layerKind(tool: McpTool, policy: ConnectorPolicy | undefined, args: unknown, precise: boolean): ToolKind | undefined {
  const forTool = (list: PolicyEntry[] | undefined) => (list ?? []).filter((e) => entryTool(e) === tool.name);
  // A conditional gate that can't be evaluated (no args in hand - the static/display path, or a
  // malformed call) is treated as gating: the safe direction for an outward action.
  if (forTool(policy?.gated).some((e) => (precise ? entryApplies(e, args, true) : true))) return "gated";
  // A conditional widening is the reverse: it only applies when it demonstrably matches, so the
  // display path (and an uninspectable call) keeps the tool at its stricter classification.
  if (forTool(policy?.read).some((e) => (precise ? entryApplies(e, args, false) : !isConditional(e)))) return "read";
  return undefined;
}

/** Decide whether a tool runs autonomously (read) or must wait for a human (gated). Default: read.
 *  Gate only money / outbound-to-people / publishing / destruction - by explicit policy, MCP's
 *  destructiveHint, or an outward-intent name.
 *
 *  This is the STATIC (display) answer, used for the agent's tool list and the operator's trust
 *  surface, where no call arguments exist yet. It is deliberately conservative: a tool carrying any
 *  conditional gate reads as "gated" here even though most of its calls will pass through. Enforcement
 *  uses `classifyCall`, which evaluates the condition against the real arguments. */
export function classifyTool(tool: McpTool, policy?: ConnectorPolicy, basePolicy?: ConnectorPolicy): ToolKind {
  return layerKind(tool, policy, undefined, false) ?? layerKind(tool, basePolicy, undefined, false) ?? intrinsicKind(tool);
}

/** The ENFORCED classification for one concrete call - the same layering as `classifyTool`, with
 *  conditional rules evaluated against the call's actual arguments. Operator overrides (`policy`) are
 *  consulted before the pack-shipped baseline (`basePolicy`), so an operator decision about a tool
 *  replaces the pack's for that tool while leaving every other tool's baseline intact. */
export function classifyCall(tool: McpTool, args: unknown, policy?: ConnectorPolicy, basePolicy?: ConnectorPolicy): ToolKind {
  return layerKind(tool, policy, args, true) ?? layerKind(tool, basePolicy, args, true) ?? intrinsicKind(tool);
}

/** True when this tool's gate depends on its arguments - so the agent's tool list can say "approval for
 *  some actions" rather than implying every call waits. */
export function hasConditionalGate(tool: McpTool, policy?: ConnectorPolicy, basePolicy?: ConnectorPolicy): boolean {
  const gates = [...(policy?.gated ?? []), ...(basePolicy?.gated ?? [])].filter((e) => entryTool(e) === tool.name);
  return gates.length > 0 && gates.every(isConditional);
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

  /** Refresh a connected provider's pack-shipped baseline. Called on every catalog sync rather than
   *  read back from persistence, so a pack that TIGHTENS a gate reaches providers already connected -
   *  a security fix must not wait for the operator to reconnect. Returns false for an unknown name. */
  setBasePolicy(name: string, basePolicy: ConnectorPolicy | undefined): boolean {
    const conn = this.conns.get(name);
    if (!conn) return false;
    if (basePolicy) conn.basePolicy = basePolicy;
    else delete conn.basePolicy;
    return true;
  }

  /** Every non-hidden tool, namespaced and tagged with its kind - what the agent's MCP client sees. */
  listTools(): GatewayToolInfo[] {
    const out: GatewayToolInfo[] = [];
    for (const conn of this.conns.values()) {
      for (const t of conn.tools) {
        if (conn.policy?.hidden?.includes(t.name)) continue;
        const conditional = hasConditionalGate(t, conn.policy, conn.basePolicy);
        out.push({
          name: `${conn.name}${SEP}${t.name}`,
          ...(t.description ? { description: t.description } : {}),
          ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
          kind: classifyTool(t, conn.policy, conn.basePolicy),
          ...(conditional ? { conditional: true } : {}),
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
          kind: hidden ? "hidden" : classifyTool(t, conn.policy, conn.basePolicy),
          // The floor the operator is adjusting AGAINST is the pack's shipped intent, not the bare
          // name heuristic - otherwise "restore to default" would silently drop a pack's gate.
          baseline: classifyTool(t, undefined, conn.basePolicy),
        });
      }
    }
    return out;
  }

  /** Reclassify one tool, OPERATOR-ADJUSTABLE both ways: read↔gated↔hidden. Under the revised
   *  invariant 5 the operator may widen an outward tool to run autonomously (they own the risk) as
   *  well as tighten a read tool to the gate - autonomy is configured, not add-only. A call that
   *  still gates crosses the injected approver, where the client's broker records the resolution on
   *  the company activity ledger; a widened tool runs as routine work and is not recorded. Returns
   *  the new connector policy so the caller can persist it. Never throws. */
  setToolPolicy(connName: string, toolName: string, target: ToolState): { ok: boolean; reason?: string; policy?: ConnectorPolicy } {
    const conn = this.conns.get(connName);
    if (!conn) return { ok: false, reason: `unknown connector: ${connName}` };
    const tool = conn.tools.find((t) => t.name === toolName);
    if (!tool) return { ok: false, reason: `unknown tool: ${toolName}` };
    // Measured against the pack's shipped intent, so "back to default" restores the pack's gate rather
    // than the bare name heuristic underneath it.
    const baseline = classifyTool(tool, undefined, conn.basePolicy);
    // Start from the operator's own overrides, strip this tool from every list, then record only a real
    // override (restoring a tool to its baseline leaves it out of all lists). basePolicy is never
    // written here - it belongs to the pack and is refreshed from the catalog on each sync.
    const strip = (arr?: PolicyEntry[]) => (arr ?? []).filter((e) => entryTool(e) !== toolName);
    const next: ConnectorPolicy = {
      read: strip(conn.policy?.read),
      gated: strip(conn.policy?.gated),
      hidden: (conn.policy?.hidden ?? []).filter((n) => n !== toolName),
    };
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

    // Enforcement is per-CALL: a conditional rule is evaluated against these arguments, so a fat
    // intent verb gates exactly the actions that reach outside and passes the routine ones through.
    if (classifyCall(tool, args, conn.policy, conn.basePolicy) === "gated") {
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
