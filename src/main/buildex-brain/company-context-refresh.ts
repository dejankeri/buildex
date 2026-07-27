import { app } from 'electron'
import { readPackCatalog } from '../buildex-packs/pack-catalog'
import { envKeyForPack, hasPackCredential } from '../buildex-packs/pack-credentials'
import { resolveBrainLocation } from './brain-location'
import { scanCompanyBrain } from './company-brain-service'
import { syncCompanyContext, type InstalledAppSummary } from './company-context'

// Keeping the agent's view of the company current, without anyone remembering to.
//
// Called from the handful of places that can actually change what the context
// says: the Brain opening, a document being created, an app being installed or
// removed. Content edits are not among them — the context is a map of what
// exists, not what it says, so saving a document changes nothing here.
//
// Cheap by construction: the render is deterministic and the write is skipped
// when the bytes match, so a call that has nothing to say touches no disk.
//
// Deliberately not wired into the running agent session. Claude Code reads
// CLAUDE.md at session start, so a refresh reaches the next session — there is
// no mechanism to push it into one already open, and pretending otherwise would
// be worse than the operator knowing the rule.

/**
 * Where the shipped catalog lives. Passed in rather than imported so this module
 * does not depend on `buildex-repo-init`, which depends on the packs it reads —
 * the cycle that would create is not worth the one saved argument.
 */
export type ContextRefreshDeps = { bundledCatalogRoot: string }

// Why: the agent should know what this company has connected without being told
// each session. Derived from the same catalog the Store reads, so it can never
// describe an app the repo does not actually have.
export function installedApps(repoPath: string, deps: ContextRefreshDeps): InstalledAppSummary[] {
  const credentialDeps = { userDataPath: app.getPath('userData') }
  return readPackCatalog(repoPath, deps.bundledCatalogRoot)
    .packs.filter((pack) => pack.installed)
    .map((pack) => ({
      id: pack.id,
      name: pack.name,
      summary: pack.summary,
      skills: pack.skills,
      hasMcp: Boolean(pack.mcp),
      ...(pack.apiKey
        ? { envKey: envKeyForPack(pack), connected: hasPackCredential(credentialDeps, pack.id) }
        : {})
    }))
}

/**
 * Rewrite the agent's company context if anything about the repo has changed.
 *
 * Never throws: a repo BuildEx cannot write to still deserves a working Brain and
 * Store, and a stale context is a smaller failure than a dead surface.
 */
export async function refreshCompanyContext(
  repoPath: string,
  deps: ContextRefreshDeps
): Promise<void> {
  try {
    // Interim: resolves for itself until Task 11 threads the location in from
    // its caller, the same way the IPC handlers already do.
    const resolution = resolveBrainLocation(repoPath)
    if (resolution.status !== 'ready') {
      return
    }
    const scan = await scanCompanyBrain(repoPath, resolution.location, resolution, Date.now())
    syncCompanyContext(repoPath, scan, installedApps(repoPath, deps))
  } catch {
    // Nothing to do about it here, and nothing worth taking a surface down for.
  }
}
