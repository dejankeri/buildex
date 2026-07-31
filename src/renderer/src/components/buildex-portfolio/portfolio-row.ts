import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import type {
  BrainFolder,
  BrainResolution,
  BrainSectionInfo
} from '../../../../shared/buildex-brain-types'

// The five columns, derived. Pure on purpose: everything the Portfolio shows is
// a reading of data other BuildEx surfaces already fetch, so the arithmetic is
// worth testing on its own and the page stays a layout.

/** Where a company's brain lives, and whether this machine has it. */
export type PortfolioBrainPlacement =
  | 'in-repo'
  | 'separate-repo'
  | 'shared'
  | 'not-cloned'
  | 'missing'
  | 'not-a-repo'

/** Why a row could not be filled in. A business is still listed either way. */
export type PortfolioDegradation = 'remote-host' | 'unreadable'

export type PortfolioLastRun = {
  at: number
  status: AutomationRun['status']
  automationName: string
}

export type PortfolioBrainSummary = {
  documentCount: number
  sectionsFilled: number
  sectionsTotal: number
}

export type PortfolioCompany = {
  repoId: string
  name: string
  badgeColor: string
  /** Workspace to activate before opening a per-repo surface; null when none is loaded. */
  worktreeId: string | null
  /** False until this repo's own fetch settles — the row renders before its cells do. */
  loaded: boolean
  degraded: PortfolioDegradation | null
  /** False when the brain folder exists but holds nothing the company wrote. */
  initialized: boolean
  brain: PortfolioBrainSummary | null
  /** Documents written and not yet saved. Null when the brain could not be read. */
  unsavedCount: number | null
  lastRun: PortfolioLastRun | null
  /** Rostered apps missing on this machine. Null when the company keeps no roster. */
  rosterGaps: number | null
  placement: PortfolioBrainPlacement | null
}

/**
 * How many of the brain's sections hold anything.
 *
 * A folder counts for its section as well as for itself: `decisions/2026` is
 * Decisions with a year in it, and a company that files by year would otherwise
 * read as never having filled the section.
 */
export function countFilledSections(folders: BrainFolder[], sections: BrainSectionInfo[]): number {
  return sections.filter((section) =>
    folders.some(
      (folder) =>
        folder.documentCount > 0 &&
        (folder.path === section.folder || folder.path.startsWith(`${section.folder}/`))
    )
  ).length
}

export function brainPlacement(resolution: BrainResolution | null): PortfolioBrainPlacement | null {
  if (!resolution) {
    return null
  }
  if (resolution.status === 'needs-clone') {
    return 'not-cloned'
  }
  if (resolution.status === 'broken') {
    return resolution.reason === 'missing' ? 'missing' : 'not-a-repo'
  }
  if (resolution.location.mode === 'embedded') {
    return 'in-repo'
  }
  // A brain repo with no remote is a supported setup, not a half-configured one
  // — see brain-sync.ts. The two read differently and must not be collapsed.
  return resolution.location.remote ? 'shared' : 'separate-repo'
}

/**
 * When a run happened, not when it was meant to.
 *
 * `scheduledFor` is in the future for anything queued, which would let a pending
 * run claim to be the last one that ran.
 */
function runTime(run: AutomationRun): number {
  return run.startedAt ?? run.dispatchedAt ?? run.createdAt
}

export function latestRunForRepo(
  repoId: string,
  automations: Automation[],
  runs: AutomationRun[]
): PortfolioLastRun | null {
  const namesById = new Map<string, string>()
  for (const automation of automations) {
    if (getAutomationRunRepoId(automation) === repoId) {
      namesById.set(automation.id, automation.name)
    }
  }
  let latest: AutomationRun | null = null
  for (const run of runs) {
    if (namesById.has(run.automationId) && (!latest || runTime(run) > runTime(latest))) {
      latest = run
    }
  }
  return latest
    ? {
        at: runTime(latest),
        status: latest.status,
        automationName: namesById.get(latest.automationId) ?? ''
      }
    : null
}
