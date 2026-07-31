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
// flight when the agent spawns reaches nobody.
//
// Never throws. A brain BuildEx cannot read costs a worktree its context, never
// its existence.

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
  try {
    await refreshCompanyContext(worktreePath, location, readInstalledAppSummaries(location))
  } catch {
    // `refreshCompanyContext` is no-throw itself; reading the shelf for it is not.
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
