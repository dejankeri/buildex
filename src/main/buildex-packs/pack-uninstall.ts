import { existsSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { PackUninstallResult } from '../../shared/buildex-packs-types'
import { embeddedLocation } from '../buildex-brain/brain-location'
import { hashFile } from './pack-files'
import { readPackCatalog } from './pack-catalog'
import { syncPackMcpConfig } from './pack-mcp-config'
import { readPackState, writePackState } from './pack-state'
import { skillsRoot, unlinkSkillFromAgentDir } from './skill-link'

// Removing a pack takes back exactly what BuildEx put in, and nothing else.
//
// The receipt in .buildex/packs.json records the hash of every file we wrote. A
// file that still matches is ours to remove; a file the operator has edited is
// theirs, and it stays — uninstalling a pack must never be a way to lose work
// somebody wrote (invariant 8).
//
// The credential is a separate decision and is left to the caller: an operator
// removing a pack to reinstall it should not have to find their API key again.

/**
 * Remove a directory once nothing is left in it. Never removes a non-empty one —
 * which is why this uses rmdir rather than a recursive delete: if the emptiness
 * check were ever wrong, rmdir refuses where rm -r would take the contents with
 * it.
 */
function removeIfEmpty(absolute: string): void {
  try {
    if (statSync(absolute).isDirectory() && readdirSync(absolute).length === 0) {
      rmdirSync(absolute)
    }
  } catch {
    // Missing or non-empty: either way there is nothing to do.
  }
}

export function uninstallPack(
  repoPath: string,
  packId: string,
  bundledRoot: string | null = null
): PackUninstallResult {
  // Embedded until packs learn the external case; see brain-remove.ts for the same shim.
  const location = embeddedLocation(repoPath)
  const state = readPackState(location)
  const record = state.packs[packId]
  if (!record) {
    return { ok: false, removedPaths: [], keptOperatorEdits: [], error: `Not installed: ${packId}` }
  }

  const removedPaths: string[] = []
  const keptOperatorEdits: string[] = []

  for (const [relativePath, recordedHash] of Object.entries(record.files)) {
    const absolute = path.join(repoPath, ...relativePath.split('/'))
    if (!existsSync(absolute)) {
      continue
    }
    if (hashFile(absolute) !== recordedHash) {
      // Edited since we wrote it — the operator's work, not ours to delete.
      keptOperatorEdits.push(relativePath)
      continue
    }
    try {
      rmSync(absolute)
      removedPaths.push(relativePath)
    } catch {
      keptOperatorEdits.push(relativePath)
    }
  }

  // Tidy the directories our files lived in, deepest first so a nested
  // references/ folder is gone before its skill folder is considered.
  const directories = [
    ...new Set(
      Object.keys(record.files).map((relativePath) =>
        path.join(repoPath, ...relativePath.split('/').slice(0, -1))
      )
    )
  ].sort((a, b) => b.length - a.length)
  for (const directory of directories) {
    removeIfEmpty(directory)
  }

  const catalog = readPackCatalog(repoPath, bundledRoot)
  const pack = catalog.packs.find((candidate) => candidate.id === packId)
  for (const skill of pack?.skills ?? []) {
    unlinkSkillFromAgentDir(repoPath, skill)
    removeIfEmpty(path.join(skillsRoot(location), skill))
  }

  delete state.packs[packId]
  try {
    writePackState(location, state)
  } catch {
    // The files are the uninstall; a stale receipt fails safe.
  }

  try {
    // Re-read so the pack now reports as not installed and its server drops out.
    syncPackMcpConfig(repoPath, readPackCatalog(repoPath, bundledRoot).packs)
  } catch {
    // A leftover server entry is visible and recoverable.
  }

  return {
    ok: true,
    removedPaths: removedPaths.sort(),
    keptOperatorEdits: keptOperatorEdits.sort()
  }
}
