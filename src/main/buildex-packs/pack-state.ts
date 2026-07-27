import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// What this repo has installed, and the exact contents we wrote. Committed with
// the repo so the record travels with the company (git is the database), and so
// a teammate cloning it can tell a pack file apart from a hand-written one.
//
// This is a receipt, not a source of truth: the catalog says what a pack is, the
// filesystem says whether it is there. If this file is lost, install still works
// — the only thing that degrades is our ability to distinguish an operator's
// edit from a stale copy, and in that case we keep the operator's version.

export const PACK_STATE_RELATIVE_PATH = '.buildex/packs.json'

export type InstalledPackRecord = {
  /** Repo-relative POSIX path -> sha256 of the contents we wrote there. */
  files: Record<string, string>
}

export type PackState = {
  packs: Record<string, InstalledPackRecord>
}

export const EMPTY_PACK_STATE: PackState = { packs: {} }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Read the receipt. A missing or unusable file reads as "nothing installed". */
export function readPackState(repoPath: string): PackState {
  const absolute = path.join(repoPath, ...PACK_STATE_RELATIVE_PATH.split('/'))
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(absolute, 'utf8'))
  } catch {
    return { packs: {} }
  }
  if (!isRecord(raw) || !isRecord(raw.packs)) {
    return { packs: {} }
  }
  const packs: Record<string, InstalledPackRecord> = {}
  for (const [packId, entry] of Object.entries(raw.packs)) {
    if (!isRecord(entry) || !isRecord(entry.files)) {
      continue
    }
    const files: Record<string, string> = {}
    for (const [relativePath, hash] of Object.entries(entry.files)) {
      if (typeof hash === 'string') {
        files[relativePath] = hash
      }
    }
    packs[packId] = { files }
  }
  return { packs }
}

/**
 * Write the receipt back. Keys are sorted so the file has one stable form and
 * an install that changes nothing produces no git diff.
 */
export function writePackState(repoPath: string, state: PackState): void {
  const absolute = path.join(repoPath, ...PACK_STATE_RELATIVE_PATH.split('/'))
  mkdirSync(path.dirname(absolute), { recursive: true })
  const packs: Record<string, InstalledPackRecord> = {}
  for (const packId of Object.keys(state.packs).sort()) {
    const files: Record<string, string> = {}
    for (const relativePath of Object.keys(state.packs[packId].files).sort()) {
      files[relativePath] = state.packs[packId].files[relativePath]
    }
    packs[packId] = { files }
  }
  const next = `${JSON.stringify({ packs }, null, 2)}\n`
  if (existsSync(absolute) && readFileSync(absolute, 'utf8') === next) {
    return
  }
  writeFileSync(absolute, next, 'utf8')
}

export function recordedHash(
  state: PackState,
  packId: string,
  relativePath: string
): string | null {
  return state.packs[packId]?.files[relativePath] ?? null
}
