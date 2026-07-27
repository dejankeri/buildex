import type { BuildExPack, PackInstallResult } from '../../shared/buildex-packs-types'
import { readPackCatalog } from './pack-catalog'
import { planSkillFiles, writePlannedFile } from './pack-files'
import { readPackState, recordedHash, writePackState } from './pack-state'
import type { PackState } from './pack-state'

// Installing a pack copies its real skill files out of the catalog into the
// company repo. They are ordinary files from that point on: `git status` after
// an install shows exactly what the company gained, and reverting is a checkout.

export type ApplyPackResult = {
  writtenPaths: string[]
  keptOperatorEdits: string[]
}

/**
 * Copy one pack's files into the repo and update the receipt in `state`.
 *
 * Shared by install and refresh, which differ only in when they run: install is
 * an operator asking for a pack, refresh is a newer app carrying newer skills.
 * Both must leave an edited file alone, so both go through the same rule.
 */
export function applyPack(repoPath: string, pack: BuildExPack, state: PackState): ApplyPackResult {
  const planned = planSkillFiles(pack.sourceDir, pack.skills)
  const files: Record<string, string> = { ...state.packs[pack.id]?.files }
  const writtenPaths: string[] = []
  const keptOperatorEdits: string[] = []

  for (const file of planned) {
    const decision = writePlannedFile(
      repoPath,
      file,
      recordedHash(state, pack.id, file.relativePath)
    )
    if (decision.outcome === 'kept-operator-edit') {
      keptOperatorEdits.push(file.relativePath)
      continue
    }
    files[file.relativePath] = decision.hash
    if (decision.outcome === 'written') {
      writtenPaths.push(file.relativePath)
    }
  }

  state.packs[pack.id] = { files }
  return { writtenPaths: writtenPaths.sort(), keptOperatorEdits: keptOperatorEdits.sort() }
}

/**
 * Install a pack by id. Safe to re-run: files the operator has edited are kept
 * and reported rather than overwritten.
 */
export function installPack(
  repoPath: string,
  packId: string,
  bundledRoot: string | null = null
): PackInstallResult {
  const catalog = readPackCatalog(repoPath, bundledRoot)
  const pack = catalog.packs.find((candidate) => candidate.id === packId)
  if (!pack) {
    return { ok: false, writtenPaths: [], keptOperatorEdits: [], error: `Unknown pack: ${packId}` }
  }
  if (pack.skills.length === 0) {
    return {
      ok: false,
      writtenPaths: [],
      keptOperatorEdits: [],
      error: `Pack declares no skills: ${packId}`
    }
  }

  const state = readPackState(repoPath)
  let applied: ApplyPackResult
  try {
    applied = applyPack(repoPath, pack, state)
  } catch (error) {
    return {
      ok: false,
      writtenPaths: [],
      keptOperatorEdits: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }

  try {
    writePackState(repoPath, state)
  } catch {
    // Why: the files are the install. A receipt we could not write costs us the
    // ability to detect operator edits later, which fails safe (we keep theirs),
    // so it must not turn a successful install into a failure.
  }

  return { ok: true, ...applied }
}
