import type { BuildExPack, PackInstallResult } from '../../shared/buildex-packs-types'
import { readPackCatalog } from './pack-catalog'
import { planSkillFiles, writePlannedFile } from './pack-files'
import { readPackState, recordedHash, writePackState } from './pack-state'
import type { PackState } from './pack-state'
import { syncPackMcpConfig } from './pack-mcp-config'
import { ensureBuildExGitExclude } from './repo-git-exclude'
import { linkSkillIntoAgentDir } from './skill-link'

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

  // Why: files under .buildex/skills are invisible to the agent — it only
  // discovers skills under .claude/skills. Without this link an install looks
  // like it worked and the pack does nothing.
  for (const skill of pack.skills) {
    if (linkSkillIntoAgentDir(repoPath, skill) === 'needs-copy') {
      copyLinkFallback(repoPath, pack, skill, files, writtenPaths)
    }
  }

  return { writtenPaths: writtenPaths.sort(), keptOperatorEdits: keptOperatorEdits.sort() }
}

/**
 * Where a symlink is unavailable (Windows without developer mode) or something
 * already occupies the path, place real files instead. Costs a duplicate; never
 * costs the operator a working skill.
 */
function copyLinkFallback(
  repoPath: string,
  pack: BuildExPack,
  skill: string,
  files: Record<string, string>,
  writtenPaths: string[]
): void {
  for (const file of planSkillFiles(pack.sourceDir, [skill])) {
    const mirrored = {
      ...file,
      relativePath: file.relativePath.replace('.buildex/skills/', '.claude/skills/')
    }
    const decision = writePlannedFile(repoPath, mirrored, files[mirrored.relativePath] ?? null)
    if (decision.outcome === 'kept-operator-edit') {
      continue
    }
    files[mirrored.relativePath] = decision.hash
    if (decision.outcome === 'written') {
      writtenPaths.push(mirrored.relativePath)
    }
  }
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

  // Machine state, not company work: make sure this clone ignores it before
  // anything lands, so it never shows up in the operator's `git status`.
  ensureBuildExGitExclude(repoPath)

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

  // Why: connect the pack's MCP server in the same step that installs its
  // skills — a pack whose skills exist but whose server is absent is a pack that
  // reads as installed and cannot do its job.
  try {
    syncPackMcpConfig(repoPath, readPackCatalog(repoPath, bundledRoot).packs)
  } catch {
    // The skills are the install; a missing server is recoverable and visible.
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
