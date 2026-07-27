import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { GatePreset, GateSettingsResult } from '../../shared/buildex-gate-types'
import { CLAUDE_SETTINGS_RELATIVE_PATH } from '../../shared/buildex-gate-types'
import { resolveGatePreset } from './gate-preset'

// Write the gate into the file the agent runtime actually enforces.
//
// This is what makes the policy real today: the agent reads
// .claude/settings.json at session start, so an `ask` rule there stops the call
// and puts the question to the operator through the agent's own prompt. No hook,
// no daemon, no second decision path that could disagree with the first.
//
// The operator's own rules are not ours to delete. We record the rules we wrote
// in .buildex/gate-applied.json; on the next sync we retire only those, and
// anything else in the file stays exactly where the operator put it.

const APPLIED_RELATIVE_PATH = '.buildex/gate-applied.json'

type PermissionLists = {
  allow: string[]
  ask: string[]
  deny: string[]
}

const LIST_NAMES = ['allow', 'ask', 'deny'] as const

function emptyLists(): PermissionLists {
  return { allow: [], ask: [], deny: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function readJson(absolute: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(absolute, 'utf8'))
    return isRecord(raw) ? raw : {}
  } catch {
    return {}
  }
}

/** The rules a previous sync wrote, so this one can retire them cleanly. */
function readApplied(repoPath: string): PermissionLists {
  const raw = readJson(path.join(repoPath, ...APPLIED_RELATIVE_PATH.split('/')))
  return {
    allow: readStringList(raw.allow),
    ask: readStringList(raw.ask),
    deny: readStringList(raw.deny)
  }
}

function writeJsonIfChanged(absolute: string, value: unknown): boolean {
  const next = `${JSON.stringify(value, null, 2)}\n`
  if (existsSync(absolute) && readFileSync(absolute, 'utf8') === next) {
    return false
  }
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, next, 'utf8')
  return true
}

/**
 * Merge one list: drop the rules we wrote last time, keep everything else in the
 * order the operator has it, then append ours that are not already present.
 */
function mergeList(current: string[], previouslyApplied: string[], desired: string[]): string[] {
  const retiring = new Set(previouslyApplied.filter((rule) => !desired.includes(rule)))
  const merged = current.filter((rule) => !retiring.has(rule))
  for (const rule of desired) {
    if (!merged.includes(rule)) {
      merged.push(rule)
    }
  }
  return merged
}

export function mergePermissions(
  current: PermissionLists,
  previouslyApplied: PermissionLists,
  preset: GatePreset
): { merged: PermissionLists; preserved: string[] } {
  const merged = emptyLists()
  const preserved: string[] = []
  for (const name of LIST_NAMES) {
    merged[name] = mergeList(current[name], previouslyApplied[name], preset[name])
    for (const rule of current[name]) {
      // A rule the operator added that our preset does not claim: report it, so
      // the UI can say the effective policy is wider or narrower than the preset.
      if (!preset[name].includes(rule) && !previouslyApplied[name].includes(rule)) {
        preserved.push(`${name}: ${rule}`)
      }
    }
  }
  return { merged, preserved: preserved.sort() }
}

/** Write the effective gate into the company repo. Idempotent. */
export function syncGateSettings(repoPath: string): GateSettingsResult {
  const { preset, source } = resolveGatePreset(repoPath)
  const settingsAbsolute = path.join(repoPath, ...CLAUDE_SETTINGS_RELATIVE_PATH.split('/'))
  const settings = readJson(settingsAbsolute)
  const permissions = isRecord(settings.permissions) ? settings.permissions : {}
  const current: PermissionLists = {
    allow: readStringList(permissions.allow),
    ask: readStringList(permissions.ask),
    deny: readStringList(permissions.deny)
  }

  const { merged, preserved } = mergePermissions(current, readApplied(repoPath), preset)

  try {
    const settingsChanged = writeJsonIfChanged(settingsAbsolute, {
      ...settings,
      permissions: { ...permissions, ...merged }
    })
    writeJsonIfChanged(path.join(repoPath, ...APPLIED_RELATIVE_PATH.split('/')), {
      allow: preset.allow,
      ask: preset.ask,
      deny: preset.deny
    })
    return { preset, source, settingsChanged, preservedRules: preserved }
  } catch (error) {
    return {
      preset,
      source,
      settingsChanged: false,
      preservedRules: preserved,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
