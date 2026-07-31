import { existsSync } from 'node:fs'
import type { BrainLocation } from '../shared/buildex-brain-types'
import { requireBrainLocation } from './buildex-brain/brain-location'
import { isBrainInitialized } from './buildex-brain/company-brain-scan'
import { refreshCompanyContext } from './buildex-brain/company-context-refresh'
import { relinkBrainSkills } from './buildex-brain/skill-link'
import { initializeCompanyRepo } from './buildex-repo-init'
import { readInstalledAppSummaries } from './buildex-store/store-catalog-source'

// What a checkout needs before an agent starts working in it.
//
// `.claude/` is git-excluded and per-checkout, so nothing a branch carries brings
// the company's context, its skills, or the gate into a fresh worktree. That
// matters most where nobody is watching: an automation creates a headless
// worktree and launches its startup agent in the same call, so without this the
// agent runs most autonomously exactly where it has the least memory and the
// fewest guardrails.
//
// Awaited by its caller, unlike the IPC surfaces that fire the same refresh and
// forget it: Claude Code reads `.claude/` at session start, so a refresh still in
// flight when the agent spawns reaches nobody. Awaited, but bounded — see below.
//
// Never throws. A brain BuildEx cannot read costs a worktree its context, never
// its existence.

/**
 * How long worktree creation will wait for the company context.
 *
 * The scan spawns `git status`, so an unreachable brain repo or a wedged git
 * could hold this open forever — and this is now on the critical path of
 * creating a worktree. Generous, because a scan that takes seconds is still
 * worth having; bounded, because no brain is worth a worktree.
 */
export const COMPANY_CONTEXT_DEADLINE_MS = 10_000

export async function prepareCompanyWorktree(worktreePath: string): Promise<void> {
  // A path this machine cannot see is not a checkout to write into — creating one
  // there would leave a phantom tree, not a company repo.
  if (!existsSync(worktreePath)) {
    return
  }
  const location = resolveLocation(worktreePath)
  if (location) {
    try {
      // Why: `.claude/skills/` is gitignored and per-checkout, so a fresh worktree
      // starts with no links into the brain and the agent here sees none of the
      // company's skills.
      relinkBrainSkills(worktreePath, location)
    } catch {
      // Skills the agent will not see. The gate below still has to land.
    }
  }
  // The gate and the git-exclude are machine state, wanted whether or not this
  // repo has a brain — and this is the moment they land, rather than whenever a
  // BuildEx surface first happens to be opened against the repo.
  initializeCompanyRepo(worktreePath)
  // A repo with nothing in its brain is a normal state, not an error: there is no
  // company context to write, and writing an empty one would put BuildEx's files
  // into a repo that never asked for them.
  if (!location || !isBrainInitialized(location)) {
    return
  }
  await refreshContextWithinDeadline(worktreePath, location)
}

/**
 * The gate, at the moment an agent starts working in a checkout.
 *
 * Synchronous and once per checkout per run, because it sits on the terminal
 * spawn path: everything it does is a small local write, and the second spawn in
 * a worktree costs a set lookup. The context is deliberately not refreshed here —
 * that reads git, and a spawn is not the place to wait for it.
 */
export function gateCompanyWorktreeOnActivation(worktreePath: string | undefined): void {
  // Undefined for a bare shell with no workspace, and absent for a worktree that
  // lives on another host. Neither is a checkout on this disk to gate.
  if (!worktreePath || !existsSync(worktreePath)) {
    return
  }
  initializeCompanyRepo(worktreePath)
}

/**
 * Wait for the context, but never indefinitely.
 *
 * A refresh that overruns is left running rather than cancelled: it writes the
 * same bytes whenever it finishes, which is exactly what the IPC surfaces do
 * today. What changes is that the agent starts without it, and says so in the log.
 */
async function refreshContextWithinDeadline(
  worktreePath: string,
  location: BrainLocation
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), COMPANY_CONTEXT_DEADLINE_MS)
    timer.unref?.()
  })
  try {
    const refreshed = refreshCompanyContext(
      worktreePath,
      location,
      readInstalledAppSummaries(location)
    ).then(() => 'refreshed' as const)
    if ((await Promise.race([refreshed, deadline])) === 'deadline') {
      console.warn(
        `[buildex] company context for ${worktreePath} took longer than ${COMPANY_CONTEXT_DEADLINE_MS}ms to scan; the agent starts without it`
      )
    }
  } catch (error) {
    // `refreshCompanyContext` is no-throw itself; reading the shelf for it is not.
    console.warn(`[buildex] company context for ${worktreePath} was not written:`, error)
  } finally {
    clearTimeout(timer)
  }
}

/** Null when the brain needs the operator before it can be used. */
function resolveLocation(worktreePath: string): BrainLocation | null {
  try {
    return requireBrainLocation(worktreePath)
  } catch {
    return null
  }
}
