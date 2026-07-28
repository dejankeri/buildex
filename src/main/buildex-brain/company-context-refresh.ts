import type { BrainLocation, BrainResolution } from '../../shared/buildex-brain-types'
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
 * Rewrite the agent's company context if anything about the repo has changed.
 *
 * Takes the installed apps rather than working them out: what is installed lives
 * in the agent's plugin state, which is the Store's half of the world, and
 * reaching into it from here would put the brain downstream of the Store.
 *
 * Never throws: a repo BuildEx cannot write to still deserves a working Brain and
 * Store, and a stale context is a smaller failure than a dead surface.
 */
export async function refreshCompanyContext(
  repoPath: string,
  location: BrainLocation,
  installedApps: InstalledAppSummary[]
): Promise<void> {
  try {
    const resolution: BrainResolution = { status: 'ready', location }
    const scan = await scanCompanyBrain(repoPath, location, resolution, Date.now())
    syncCompanyContext(repoPath, scan, installedApps, location)
  } catch {
    // Nothing to do about it here, and nothing worth taking a surface down for.
  }
}
