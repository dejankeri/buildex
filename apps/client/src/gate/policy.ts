// The policy engine - the allow/ask/deny decision (net-new; invariant 5). It mirrors the CLI's own
// permission-rule grammar ("Tool" or "Tool(argPrefix:*)") so the same preset both drives this gate
// and is written into the generated .claude/settings.json (module 6). Pure and deterministic.

export type Decision = "allow" | "ask" | "deny";

export interface PolicyPreset {
  allow: string[];
  ask: string[];
  deny: string[];
  /** Decision for a tool no rule matches. */
  default: Decision;
}

export interface ToolInvocation {
  name: string;
  input: Record<string, unknown>;
}

interface Rule {
  tool: string;
  /** Command/argument prefix to match against `input.command` (undefined = tool-level rule). */
  argPrefix?: string;
}

export class PolicyEngine {
  private readonly allow: Rule[];
  private readonly ask: Rule[];
  private readonly deny: Rule[];

  constructor(private readonly preset: PolicyPreset) {
    this.allow = preset.allow.map(parseRule);
    this.ask = preset.ask.map(parseRule);
    this.deny = preset.deny.map(parseRule);
  }

  decide(tool: ToolInvocation): Decision {
    // Deny is absolute: any matching deny rule forbids the call.
    if (this.bestSpecificity(this.deny, tool) > 0) return "deny";

    // Otherwise the most specific matching rule across allow/ask wins (specific pre-approval beats
    // a broad ask, and vice-versa).
    const allowSpec = this.bestSpecificity(this.allow, tool);
    const askSpec = this.bestSpecificity(this.ask, tool);
    if (allowSpec === 0 && askSpec === 0) return this.preset.default;
    return allowSpec >= askSpec ? "allow" : "ask";
  }

  /** The specificity of the best-matching rule in `rules` (0 = no match). */
  private bestSpecificity(rules: Rule[], tool: ToolInvocation): number {
    let best = 0;
    for (const rule of rules) {
      const spec = matchSpecificity(rule, tool);
      if (spec > best) best = spec;
    }
    return best;
  }
}

function parseRule(raw: string): Rule {
  const m = raw.match(/^([^(]+)\(([^)]*)\)$/);
  if (!m) return { tool: raw };
  const arg = m[2]!.replace(/:\*$/, "").replace(/\*$/, "");
  return { tool: m[1]!, argPrefix: arg };
}

/** 0 = no match; 1 = tool-level match; 100 + prefix length = argument-prefix match (more specific). */
function matchSpecificity(rule: Rule, tool: ToolInvocation): number {
  if (rule.tool !== tool.name) return 0;
  if (rule.argPrefix === undefined) return 1;
  const command = typeof tool.input["command"] === "string" ? (tool.input["command"] as string) : "";
  return command.startsWith(rule.argPrefix) ? 100 + rule.argPrefix.length : 0;
}
