import { cpSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { BrainRemovalPlan, BrainRemovalResult } from '../../shared/buildex-brain-types'
import { gitExecFileAsync } from '../git/runner'
import { AGENT_SKILLS_DIR } from '../buildex-packs/skill-link'
import { BRAIN_ROOT, isBrainInitialized } from './company-brain-scan'
import { readBrainHistory } from './brain-history'

// Removing the company brain, without ever destroying it.
//
// This is the most consequential control in the app, so it is built so that the
// operator cannot lose anything by using it (invariant 8). Two paths, and the
// dialog says which one is about to run:
//
//   - git holds it -> the removal is committed, so it is one `git revert` away.
//   - anything is uncommitted, or there is no git at all -> a copy is taken
//     first and the operator is told exactly where it went.
//
// Both can happen at once, and when in doubt both do. A backup that turns out to
// be redundant costs a few kilobytes; the other mistake costs somebody's writing.

export const BACKUP_ROOT = path.join(homedir(), '.buildex-backups')

const REMOVAL_MESSAGE = 'Removed the company brain'

/** `2026-07-27-142530` — sorts chronologically and is legible in a file dialog. */
export function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '')
}

export async function planBrainRemoval(repoPath: string): Promise<BrainRemovalPlan> {
  const history = await readBrainHistory(repoPath, 1)
  const documentCount = countDocuments(path.join(repoPath, BRAIN_ROOT))
  return {
    documentCount,
    unsavedPaths: history.unsavedPaths,
    // A brain with no save behind it cannot be recovered from history, however
    // healthy the git repo around it is.
    canCommit: !history.unavailable && history.saves.length > 0,
    willBackUp: history.unavailable || history.unsavedPaths.length > 0
  }
}

/** Every markdown file under the brain — what the confirmation counts. */
function countDocuments(absoluteRoot: string): number {
  let total = 0
  const walk = (directory: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue
      }
      if (entry.isDirectory()) {
        walk(path.join(directory, entry.name))
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        total += 1
      }
    }
  }
  walk(absoluteRoot)
  return total
}

/**
 * Drop `.claude/skills/` links that now point at nothing.
 *
 * Without this the agent is left holding symlinks into a folder that no longer
 * exists, which reads to it as a set of broken skills. Only ever removes a
 * symlink, and only one whose target is gone — a real directory somebody put
 * there by hand is untouched.
 */
export function pruneDanglingSkillLinks(repoPath: string): string[] {
  const root = path.join(repoPath, AGENT_SKILLS_DIR)
  let entries: string[]
  try {
    entries = readdirSync(root).sort()
  } catch {
    return []
  }
  const pruned: string[] = []
  for (const entry of entries) {
    const linkPath = path.join(root, entry)
    try {
      if (!lstatSync(linkPath).isSymbolicLink()) {
        continue
      }
      realpathSync(linkPath)
    } catch {
      // Either it stopped being readable or it resolves nowhere; both mean the
      // link is no longer usable by the agent.
      try {
        rmSync(linkPath)
        pruned.push(entry)
      } catch {
        // Nothing to do about a link we cannot remove.
      }
    }
  }
  return pruned
}

/**
 * Take the brain out of the repo.
 *
 * `now` is passed in rather than read so the backup path is deterministic and
 * this can be tested without waiting for a clock to move.
 */
export async function removeBrain(repoPath: string, now: number): Promise<BrainRemovalResult> {
  const brainRoot = path.join(repoPath, BRAIN_ROOT)
  if (!isBrainInitialized(repoPath)) {
    return { ok: false, committed: false, error: 'There is no company brain here' }
  }

  const plan = await planBrainRemoval(repoPath)

  let backupPath: string | undefined
  if (plan.willBackUp) {
    // Before anything is removed, so a failure here stops the removal rather
    // than leaving the operator with neither the brain nor a copy.
    try {
      backupPath = path.join(BACKUP_ROOT, `${path.basename(repoPath)}-${backupStamp(now)}`)
      mkdirSync(backupPath, { recursive: true })
      cpSync(brainRoot, backupPath, { recursive: true })
    } catch (error) {
      return {
        ok: false,
        committed: false,
        error: `Could not back the brain up, so nothing was removed: ${message(error)}`
      }
    }
  }

  let committed = false
  if (plan.canCommit) {
    try {
      // Forced because the backup above already covers anything git would refuse
      // to drop, and pathspec-scoped so no other work in the tree is swept up.
      await gitExecFileAsync(['rm', '-r', '-f', '--quiet', '--', BRAIN_ROOT], { cwd: repoPath })
      await gitExecFileAsync(['commit', '-m', REMOVAL_MESSAGE, '--', BRAIN_ROOT], { cwd: repoPath })
      committed = true
    } catch {
      // Fall through to the plain removal: the copy is already taken, or git had
      // nothing of ours to lose.
    }
  }

  try {
    // Untracked files survive `git rm`, and there is no git on the other path.
    rmSync(brainRoot, { recursive: true, force: true })
  } catch (error) {
    return { ok: false, committed, backupPath, error: message(error) }
  }

  pruneDanglingSkillLinks(repoPath)
  return { ok: true, committed, backupPath }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
