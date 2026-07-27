import type { PackRefreshResult } from '../../shared/buildex-packs-types'
import { embeddedLocation, requireBrainLocation } from '../buildex-brain/brain-location'
import { readPackCatalog } from './pack-catalog'
import { applyPack } from './pack-install'
import { readPackState, writePackState } from './pack-state'

// Re-sync installed packs against the catalog the running app ships. This is
// the update path: a new BuildEx release carries newer skills, and an operator
// who installed Slack six months ago should get the improved Slack skills
// without reinstalling anything.
//
// Only packs already recorded as installed are touched — refreshing must never
// add a capability the company did not ask for.

export function refreshInstalledPacks(
  repoPath: string,
  bundledRoot: string | null = null
): PackRefreshResult {
  const location = requireBrainLocation(repoPath) ?? embeddedLocation(repoPath)
  const state = readPackState(location)
  const installedIds = Object.keys(state.packs)
  if (installedIds.length === 0) {
    return { updatedPackIds: [], writtenPaths: [], keptOperatorEdits: [] }
  }

  const catalog = readPackCatalog(repoPath, bundledRoot)
  const updatedPackIds: string[] = []
  const writtenPaths: string[] = []
  const keptOperatorEdits: string[] = []

  for (const packId of installedIds.sort()) {
    const pack = catalog.packs.find((candidate) => candidate.id === packId)
    // Why: a pack can disappear from the catalog (renamed upstream, or a repo
    // fork removed). Its files stay in the repo untouched — deleting a
    // company's skills because a catalog changed would lose their work.
    if (!pack) {
      continue
    }
    let applied: { writtenPaths: string[]; keptOperatorEdits: string[] }
    try {
      applied = applyPack(repoPath, location, pack, state)
    } catch {
      continue
    }
    if (applied.writtenPaths.length > 0) {
      updatedPackIds.push(packId)
      writtenPaths.push(...applied.writtenPaths)
    }
    keptOperatorEdits.push(...applied.keptOperatorEdits)
  }

  if (writtenPaths.length > 0 || keptOperatorEdits.length > 0) {
    try {
      writePackState(location, state)
    } catch {
      // Same reasoning as install: the files are the result, the receipt is not.
    }
  }

  return {
    updatedPackIds,
    writtenPaths: writtenPaths.sort(),
    keptOperatorEdits: keptOperatorEdits.sort()
  }
}
