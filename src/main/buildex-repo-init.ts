import { resolve } from 'node:path'
import { app } from 'electron'
import { buildexCatalogRootFrom } from './buildex-packs/bundled-catalog'
import { refreshInstalledPacks } from './buildex-packs/pack-refresh'
import { syncGateSettings } from './buildex-gate/gate-settings'

// What BuildEx does the first time a run touches a company repo: bring installed
// packs up to the catalog this build ships, and put the gate into the file the
// agent enforces.
//
// Once per repo per run. Both steps are idempotent, so repeating them is only
// wasted work — but they write to disk, and a read of the Store or the Brain
// should not re-walk every pack each time it is opened.
//
// Called from the BuildEx IPC entry points rather than from worktree activation,
// which is upstream surface this fork keeps thin. The cost is that the gate lands
// when a BuildEx surface is first used rather than the instant a repo opens; see
// PROGRESS.md.

const initialized = new Set<string>()

// Why: packaged builds get the catalog from extraResources; a dev run reads the
// same tree straight out of the repo. Resolved here rather than passed in, so
// every caller initializes a repo the same way — an earlier version let the
// Brain initialize with no catalog and then mark the repo done, which silently
// skipped the pack refresh the Store would have run.
export function bundledCatalogRoot(): string {
  const resourceRoot = app.isPackaged ? process.resourcesPath : resolve(process.cwd(), 'resources')
  return buildexCatalogRootFrom(resourceRoot)
}

export function initializeCompanyRepo(repoPath: string): void {
  if (initialized.has(repoPath)) {
    return
  }
  initialized.add(repoPath)
  try {
    refreshInstalledPacks(repoPath, bundledCatalogRoot())
  } catch {
    // A repo we cannot write to still deserves a readable Store and Brain.
  }
  try {
    syncGateSettings(repoPath)
  } catch {
    // Same: never let policy bookkeeping take a surface down.
  }
}

/** Test seam — a fresh process would not remember previous repos. */
export function resetCompanyRepoInitialization(): void {
  initialized.clear()
}
