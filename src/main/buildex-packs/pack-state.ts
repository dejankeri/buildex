import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrainLocation } from '../../shared/buildex-brain-types'

// What this repo has installed, and the exact contents we wrote. Committed with
// the repo so the record travels with the company (git is the database), and so
// a teammate cloning it can tell a pack file apart from a hand-written one.
//
// This is a receipt, not a source of truth: the catalog says what a pack is, the
// filesystem says whether it is there. If this file is lost, install still works
// — the only thing that degrades is our ability to distinguish an operator's
// edit from a stale copy, and in that case we keep the operator's version.
//
// Lives at the brain root, not the repo root: the receipt travels with the
// skills it describes, wherever the brain is.

export const PACK_STATE_FILE_NAME = 'packs.json'

export function packStatePath(location: BrainLocation): string {
  return path.join(location.root, PACK_STATE_FILE_NAME)
}

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
export function readPackState(location: BrainLocation): PackState {
  const absolute = packStatePath(location)
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
export function writePackState(location: BrainLocation, state: PackState): void {
  const absolute = packStatePath(location)
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

/**
 * The legacy key a brain-relative `skills/…` path would have had before packs
 * moved to the brain root — receipts from before this migration recorded it
 * repo-relative, under `.buildex/`. `.claude/…` fallback-copy keys never had a
 * `.buildex/` prefix in either scheme, so they have no legacy form.
 */
function legacyReceiptKey(relativePath: string): string | null {
  return relativePath.startsWith('skills/') ? `.buildex/${relativePath}` : null
}

/**
 * The hash we recorded for a file last time, checking the legacy key too — an
 * old receipt naming this file `.buildex/skills/…` must still count as "we
 * wrote this", or a refresh mistakes its own earlier install for an operator
 * edit and stops updating it.
 */
export function recordedHash(
  state: PackState,
  packId: string,
  relativePath: string
): string | null {
  const files = state.packs[packId]?.files
  if (!files) {
    return null
  }
  if (relativePath in files) {
    return files[relativePath]
  }
  const legacy = legacyReceiptKey(relativePath)
  return legacy && legacy in files ? files[legacy] : null
}

/**
 * Record a file at its (new-shape) key, and drop the legacy key for the same
 * physical file if one is still sitting there. A migration that leaves the old
 * row behind isn't finished — without this, the stale key survives forever at
 * its pre-migration hash, and a later uninstall reads it as an operator edit
 * even though the same file was just correctly removed under its new key.
 */
export function recordReceiptFile(
  files: Record<string, string>,
  relativePath: string,
  hash: string
): void {
  files[relativePath] = hash
  const legacy = legacyReceiptKey(relativePath)
  if (legacy) {
    delete files[legacy]
  }
}

/**
 * Where a receipt-recorded path resolves on disk. The key's own shape says the
 * base: `.claude/` is always repo-relative, anything unprefixed is brain-root-
 * relative (the shape every new receipt uses), and a `.buildex/` key predates
 * external brains.
 *
 * That last one is why the mode matters: after a migration `<repo>/.buildex`
 * holds only the pointer, and resolving a surviving legacy key there names a
 * file that does not exist — which uninstall reads as "already gone", deleting
 * the receipt while the pack's files sit untouched in the shared brain.
 */
export function resolveReceiptPath(
  repoPath: string,
  location: BrainLocation,
  relativePath: string
): string {
  const segments = relativePath.split('/')
  if (relativePath.startsWith('.buildex/')) {
    return location.mode === 'external'
      ? path.join(location.root, ...segments.slice(1))
      : path.join(repoPath, ...segments)
  }
  if (relativePath.startsWith('.claude/')) {
    return path.join(repoPath, ...segments)
  }
  return path.join(location.root, ...segments)
}
