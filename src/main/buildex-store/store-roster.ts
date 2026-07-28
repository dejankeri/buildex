import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  StoreRequirement,
  StoreRoster,
  StoreRosterEntry
} from '../../shared/buildex-store-types'
import type { BrainLocation } from '../../shared/buildex-brain-types'

// The company's app roster: which apps a person joining this company is
// expected to install.
//
// Delegating installs to the agent made them per-operator, which is right —
// each person installs what they need on the machine they need it on. But it
// also meant nothing about apps travelled with a clone any more, and a new
// teammate had no way to know that this company runs on Protocol.
//
// This file is that missing half, and it is the half that belongs in git: not
// the plugin bytes, just the expectation. It lives in the brain, so it is
// committed, reviewed and shared exactly like every other company document.

export const ROSTER_FILE_NAME = 'apps.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Absolute path of the roster inside a brain. */
export function rosterPath(location: BrainLocation): string {
  return path.join(location.root, ROSTER_FILE_NAME)
}

/**
 * How the roster is referred to in the UI.
 *
 * An embedded brain lives under the repo, so the repo-relative path is the
 * useful thing to show; an external brain is its own repo and the bare filename
 * is less misleading than a path into somebody else's checkout.
 */
export function rosterDisplayPath(location: BrainLocation): string {
  return location.mode === 'embedded'
    ? path.posix.join(path.basename(location.root), ROSTER_FILE_NAME)
    : ROSTER_FILE_NAME
}

function parseEntry(value: unknown): StoreRosterEntry | null {
  if (!isRecord(value)) {
    return null
  }
  const pluginName = asString(value.pluginName ?? value.plugin)
  const marketplaceId = asString(value.marketplaceId ?? value.marketplace)
  const requirement = value.requirement
  if (
    !pluginName ||
    !marketplaceId ||
    (requirement !== 'required' && requirement !== 'suggested')
  ) {
    return null
  }
  const entry: StoreRosterEntry = { pluginName, marketplaceId, requirement }
  const reason = asString(value.reason)
  if (reason) {
    entry.reason = reason
  }
  return entry
}

/** Parse a roster file body. A malformed row is skipped, not fatal. */
export function parseStoreRoster(json: string, displayPath: string): StoreRoster {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    // Why: a roster somebody hand-edited into invalid JSON must not empty the
    // Store. It reads as "nothing expected", and the file is still theirs.
    return { entries: [], path: displayPath }
  }
  const rows = isRecord(raw) && Array.isArray(raw.apps) ? raw.apps : Array.isArray(raw) ? raw : []
  const entries = new Map<string, StoreRosterEntry>()
  for (const row of rows) {
    const entry = parseEntry(row)
    if (entry) {
      entries.set(`${entry.pluginName}@${entry.marketplaceId}`, entry)
    }
  }
  return { entries: [...entries.values()], path: displayPath }
}

/** The roster a brain holds, or an empty one when it has none yet. */
export function readStoreRoster(location: BrainLocation): StoreRoster {
  const displayPath = rosterDisplayPath(location)
  try {
    return parseStoreRoster(readFileSync(rosterPath(location), 'utf8'), displayPath)
  } catch {
    return { entries: [], path: displayPath }
  }
}

function serialize(entries: readonly StoreRosterEntry[]): string {
  // Sorted so two people marking apps in different orders do not produce a
  // spurious diff for each other to resolve.
  const sorted = [...entries].sort(
    (a, b) =>
      a.pluginName.localeCompare(b.pluginName) || a.marketplaceId.localeCompare(b.marketplaceId)
  )
  return `${JSON.stringify({ apps: sorted }, null, 2)}\n`
}

/**
 * Put an app on the roster, or take it off with `requirement: null`.
 *
 * Writes the whole file rather than patching it: the roster is small, and a
 * deterministic rewrite is what keeps the diff a teammate reviews readable.
 */
export function setRosterEntry(
  location: BrainLocation,
  change: {
    pluginName: string
    marketplaceId: string
    requirement: StoreRequirement | null
    reason?: string
  }
): StoreRoster {
  const current = readStoreRoster(location)
  const key = `${change.pluginName}@${change.marketplaceId}`
  const kept = current.entries.filter(
    (entry) => `${entry.pluginName}@${entry.marketplaceId}` !== key
  )
  if (change.requirement) {
    kept.push({
      pluginName: change.pluginName,
      marketplaceId: change.marketplaceId,
      requirement: change.requirement,
      ...(change.reason?.trim() ? { reason: change.reason.trim() } : {})
    })
  }

  const target = rosterPath(location)
  if (kept.length === 0) {
    // An empty roster is no roster: leaving `{"apps": []}` behind would show a
    // teammate a file that says nothing.
    try {
      rmSync(target, { force: true })
    } catch {
      // A file we cannot remove is stale, not harmful — it parses as empty.
    }
    return { entries: [], path: current.path }
  }

  mkdirSync(path.dirname(target), { recursive: true })
  const next = serialize(kept)
  if (!existsSync(target) || readFileSync(target, 'utf8') !== next) {
    writeFileSync(target, next, 'utf8')
  }
  return { entries: parseStoreRoster(next, current.path).entries, path: current.path }
}

/** Index the roster for lookup while the shelf is assembled. */
export function rosterIndex(roster: StoreRoster | null): Map<string, StoreRosterEntry> {
  const index = new Map<string, StoreRosterEntry>()
  for (const entry of roster?.entries ?? []) {
    index.set(`${entry.pluginName}@${entry.marketplaceId}`, entry)
  }
  return index
}
