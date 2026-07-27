import type { GateDecision, GatePreset, ToolInvocation } from '../../shared/buildex-gate-types'

// The allow/ask/deny decision. Pure and deterministic: same preset and same tool
// call always give the same answer, with no model in the loop (invariant 9).
//
// The rule grammar mirrors the agent runtime's own permission rules — "Tool" or
// "Tool(argPrefix:*)" — precisely so one preset can both drive this evaluation
// and be written into .claude/settings.json without translation. A grammar of
// our own would be a second source of truth that could disagree with the file
// the agent actually enforces.

type Rule = {
  tool: string
  /** Command prefix matched against `input.command`; undefined = tool-level rule. */
  argPrefix?: string
}

/** 0 = no match, 1 = tool-level match, 100+n = argument-prefix match of length n. */
const TOOL_LEVEL_SPECIFICITY = 1
const ARG_PREFIX_SPECIFICITY_BASE = 100

export function parseRule(raw: string): Rule {
  const match = raw.match(/^([^(]+)\(([^)]*)\)$/)
  if (!match) {
    return { tool: raw.trim() }
  }
  const argPrefix = match[2].replace(/:\*$/, '').replace(/\*$/, '')
  return { tool: match[1].trim(), argPrefix }
}

function matchSpecificity(rule: Rule, tool: ToolInvocation): number {
  if (rule.tool !== tool.name) {
    return 0
  }
  if (rule.argPrefix === undefined) {
    return TOOL_LEVEL_SPECIFICITY
  }
  const command = typeof tool.input.command === 'string' ? tool.input.command : ''
  return command.startsWith(rule.argPrefix)
    ? ARG_PREFIX_SPECIFICITY_BASE + rule.argPrefix.length
    : 0
}

function bestSpecificity(rules: string[], tool: ToolInvocation): number {
  let best = 0
  for (const raw of rules) {
    const specificity = matchSpecificity(parseRule(raw), tool)
    if (specificity > best) {
      best = specificity
    }
  }
  return best
}

/**
 * Decide what happens to one tool call.
 *
 * Deny is absolute. Otherwise the most specific matching rule wins, so a narrow
 * pre-approval can carve an exception out of a broad ask, and a narrow ask can
 * carve a gate out of a broad allow — which is the whole point of "wide
 * autonomy, few gates": `Bash` is allowed, `Bash(rm -rf:*)` still stops.
 */
export function decide(preset: GatePreset, tool: ToolInvocation): GateDecision {
  if (bestSpecificity(preset.deny, tool) > 0) {
    return 'deny'
  }
  const allowSpecificity = bestSpecificity(preset.allow, tool)
  const askSpecificity = bestSpecificity(preset.ask, tool)
  if (allowSpecificity === 0 && askSpecificity === 0) {
    return preset.default
  }
  return allowSpecificity >= askSpecificity ? 'allow' : 'ask'
}
