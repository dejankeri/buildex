import { ensureBuildExGitExclude } from './buildex-brain/repo-git-exclude'
import { syncGateSettings } from './buildex-gate/gate-settings'
import { removeLegacyPackMcpServers } from './buildex-store/legacy-mcp-config-cleanup'
import { collectPluginGateRules } from './buildex-store/plugin-env'
import { readAppStoreCatalog } from './buildex-store/store-catalog-source'

// What BuildEx does the first time a run touches a company repo: keep what it
// writes out of the operator's git index, and put the gate into the file the
// agent enforces.
//
// Once per repo per run. Both steps are idempotent, so repeating them is only
// wasted work — but they write to disk, and a read of the Store or the Brain
// should not redo them each time it is opened.
//
// No plugin work happens here any more. Installing is the agent's own plugin
// CLI, per operator rather than per repo, so there is nothing about a repo to
// bring up to date on open.
//
// Called from the BuildEx IPC entry points rather than from worktree activation,
// which is upstream surface this fork keeps thin. The cost is that the gate lands
// when a BuildEx surface is first used rather than the instant a repo opens; see
// PROGRESS.md.

const initialized = new Set<string>()

export function initializeCompanyRepo(repoPath: string): void {
  if (initialized.has(repoPath)) {
    return
  }
  initialized.add(repoPath)
  // First, so nothing BuildEx writes below can reach the operator's git index.
  try {
    ensureBuildExGitExclude(repoPath)
  } catch {
    // A folder with no .git simply has no git to keep clean.
  }
  // Why: a previous BuildEx generated `.mcp.json` with a server per installed
  // pack. Plugins now carry their own, so an upgraded repo would show the agent
  // every app twice until ours is taken back.
  try {
    removeLegacyPackMcpServers(repoPath)
  } catch {
    // A file we could not rewrite is a duplicate server, not a broken surface.
  }
  // Why: the brain's sections are NOT written here. The gate is machine state and
  // belongs to BuildEx; the sections are the company's own files, and writing a
  // dozen of them into a repo somebody opened to browse the Store was never ours
  // to do. Setup asks first; see brain-scaffold.ts.
  //
  // The installed plugins' own rules go in with it: syncing without them would
  // take an installed app's gates back out every time a surface is opened.
  try {
    syncGateSettings(repoPath, installedPluginGateRules())
  } catch {
    // Never let policy bookkeeping take a surface down.
  }
}

/** Empty rather than throwing: an unreadable shelf must not cost the gate. */
function installedPluginGateRules(): { ask: string[]; deny: string[] } {
  try {
    return collectPluginGateRules(readAppStoreCatalog().entries)
  } catch {
    return { ask: [], deny: [] }
  }
}

/** Test seam — a fresh process would not remember previous repos. */
export function resetCompanyRepoInitialization(): void {
  initialized.clear()
}
