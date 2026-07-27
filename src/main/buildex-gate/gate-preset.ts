import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { GateDecision, GatePreset, GatePresetSource } from '../../shared/buildex-gate-types'
import { GATE_PRESET_RELATIVE_PATH } from '../../shared/buildex-gate-types'

// The preset BuildEx ships, and how a company overrides it.
//
// Wide by default: reading, editing, searching, running commands and using the
// web are the agent's ordinary work and never interrupt anyone. The ask list is
// deliberately short and covers one thing — actions that destroy work or rewrite
// shared history, where a wrong call cannot be undone by reading the diff.
//
// Outbound-to-people and money live in pack manifests (a pack's mcp.policy names
// its own gated tools), not here, because only the pack knows which of its verbs
// send an email or move a euro.

export const DEFAULT_GATE_PRESET: GatePreset = {
  allow: [
    'Read',
    'Grep',
    'Glob',
    'LS',
    'Edit',
    'Write',
    'NotebookEdit',
    'TodoWrite',
    'WebFetch',
    'WebSearch',
    'Bash'
  ],
  ask: [
    'Bash(rm -rf:*)',
    'Bash(rm -fr:*)',
    'Bash(git push --force:*)',
    'Bash(git push -f:*)',
    'Bash(git push --force-with-lease:*)',
    'Bash(git reset --hard:*)'
  ],
  deny: [],
  default: 'allow'
}

function isDecision(value: unknown): value is GateDecision {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const rules = value.filter(
    (entry): entry is string => typeof entry === 'string' && !!entry.trim()
  )
  return rules.map((rule) => rule.trim())
}

/**
 * Parse a preset a company wrote by hand. A partial file is usable — any list it
 * omits falls back to the shipped default, so an operator can add one ask rule
 * without restating the whole policy.
 *
 * Returns null only when the file is not a usable object at all. A broken
 * preset must not silently become "no gates".
 */
export function parseGatePreset(json: string): GatePreset | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const record = raw as Record<string, unknown>
  return {
    allow: stringList(record.allow) ?? DEFAULT_GATE_PRESET.allow,
    ask: stringList(record.ask) ?? DEFAULT_GATE_PRESET.ask,
    deny: stringList(record.deny) ?? DEFAULT_GATE_PRESET.deny,
    default: isDecision(record.default) ? record.default : DEFAULT_GATE_PRESET.default
  }
}

export type ResolvedGatePreset = {
  preset: GatePreset
  source: GatePresetSource
}

/** The company's preset if it has one, otherwise the one BuildEx ships. */
export function resolveGatePreset(repoPath: string): ResolvedGatePreset {
  const absolute = path.join(repoPath, ...GATE_PRESET_RELATIVE_PATH.split('/'))
  let body: string
  try {
    body = readFileSync(absolute, 'utf8')
  } catch {
    return { preset: DEFAULT_GATE_PRESET, source: 'bundle' }
  }
  const parsed = parseGatePreset(body)
  // Why: an unreadable override falls back to the shipped preset rather than to
  // nothing. A typo in this file must never widen what the agent may do.
  return parsed
    ? { preset: parsed, source: 'repo' }
    : { preset: DEFAULT_GATE_PRESET, source: 'bundle' }
}
