import { existsSync } from 'node:fs'
import type { AutomationWorkspaceContextRequest } from '../shared/buildex-automation-context-types'
import type { BrainLocation } from '../shared/buildex-brain-types'
import { splitWorktreeIdForFilesystem } from '../shared/worktree-id'
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
  // First, and before anything below writes: it installs the git-exclude, and
  // that has to be in place before `.claude/skills/` links exist to be seen by
  // the operator's index. It also carries the gate, which is the part that must
  // land whether or not this repo has a brain.
  initializeCompanyRepo(worktreePath)
  const location = resolveLocation(worktreePath)
  if (location) {
    try {
      // Why: `.claude/skills/` is gitignored and per-checkout, so a fresh worktree
      // starts with no links into the brain and the agent here sees none of the
      // company's skills.
      relinkBrainSkills(worktreePath, location)
    } catch {
      // Skills the agent will not see. The gate is already in.
    }
  }
  // A repo with nothing in its brain is a normal state, not an error: there is no
  // company context to write, and writing an empty one would put BuildEx's files
  // into a repo that never asked for them.
  if (!location || !isBrainInitialized(location)) {
    return
  }
  await refreshContextWithinDeadline(worktreePath, location)
}

/** Which host a workspace's repo is on — the only question asked of the store. */
type WorkspaceRepoLookup = {
  getRepo: (repoId: string) => { connectionId?: string | null } | undefined
}

/**
 * The same preparation, for an automation that runs in a checkout it did not create.
 *
 * `existing` is the Automations UI's default, so this is the common dispatch and
 * not the edge case: without it those runs read whatever `.claude/` a Brain or
 * Store interaction last happened to leave there. Both dispatch paths — headless
 * and renderer-present, the latter through `buildex-automation-context:*` — land
 * here, so neither can drift from the other.
 *
 * A scheduled dispatch can afford the bounded wait that worktree creation takes;
 * a human opening a terminal cannot, which is why `gateCompanyWorktreeOnActivation`
 * still refreshes nothing.
 *
 * Host identity is carried, never inferred from the path: an SSH workspace's path
 * names the *remote* filesystem, so a repo with a `connectionId` — and a workspace
 * whose repo cannot be looked up at all — is left alone rather than guessed at.
 */
export async function prepareCompanyWorktreeForAutomationRun(
  automation: AutomationWorkspaceContextRequest,
  repos: WorkspaceRepoLookup | null | undefined
): Promise<void> {
  // `new_per_run` is already prepared as its worktree is created; scanning again
  // would spend a second deadline on context the agent has by then.
  if (automation.workspaceMode === 'new_per_run' || !automation.workspaceId || !repos) {
    return
  }
  const parsed = splitWorktreeIdForFilesystem(automation.workspaceId)
  const repo = parsed ? repos.getRepo(parsed.repoId) : undefined
  // No repo is no host: a workspace BuildEx cannot place on this machine is left
  // alone rather than written to on the chance that the path is local.
  if (!parsed || !repo || repo.connectionId) {
    return
  }
  await prepareCompanyWorktree(parsed.worktreePath)
}

/**
 * The gate, at the moment an agent starts working in a checkout.
 *
 * Synchronous and once per checkout per run, because it sits on the terminal
 * spawn path: everything it does is a small local write, and the second spawn in
 * a worktree costs a set lookup. The context is deliberately not refreshed here —
 * that reads git, and a spawn is not the place to wait for it.
 *
 * `connectionId` names an SSH connection, and a remote worktree's path belongs to
 * the *remote* filesystem. A path that also exists on this machine is a different
 * directory, so gating on it would write into an unrelated local folder and still
 * leave the real checkout ungated. **Remote worktrees are therefore not gated on
 * activation at all** — that needs a writer on the far side, which BuildEx does
 * not have yet. Their gate still lands when a BuildEx surface touches the repo.
 */
export function gateCompanyWorktreeOnActivation(
  worktreePath: string | undefined,
  connectionId?: string | null
): void {
  if (connectionId) {
    return
  }
  // Undefined for a bare shell with no workspace, absent for a checkout this
  // machine does not have. Neither is a directory to gate.
  if (!worktreePath || !existsSync(worktreePath)) {
    return
  }
  initializeCompanyRepo(worktreePath)
}

/**
 * Wait for the context, but never indefinitely.
 *
 * A refresh that overruns is left running rather than cancelled. It can therefore
 * land after a later refresh has already written a newer one — a lost update that
 * reverts the context by one scan. Small and self-healing: the render is
 * deterministic, and the next refresh of a repo that has changed corrects it. A
 * stale context for one session beats an unbounded wait for every worktree.
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
      readInstalledAppSummaries(location, worktreePath)
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
