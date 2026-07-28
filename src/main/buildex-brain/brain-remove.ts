import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  BrainLocation,
  BrainRemovalPlan,
  BrainRemovalResult
} from '../../shared/buildex-brain-types'
import { gitExecFileAsync } from '../git/runner'
import { pruneDanglingSkillLinks, unlinkBrainSkills } from '../buildex-packs/skill-link'
import { isBrainInitialized } from './company-brain-scan'
import { removeBrainPointer, requireBrainLocation } from './brain-location'
import { unbindRepo } from './brain-bindings'
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

export async function planBrainRemoval(location: BrainLocation): Promise<BrainRemovalPlan> {
  const history = await readBrainHistory(location, 1)
  const documentCount = countDocuments(location.root)
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
 * Take the brain out of the repo.
 *
 * `now` is passed in rather than read so the backup path is deterministic and
 * this can be tested without waiting for a clock to move.
 */
export async function removeBrain(
  repoPath: string,
  location: BrainLocation,
  now: number
): Promise<BrainRemovalResult> {
  // Defence in depth: an external brain may be shared, so deleting it is never this function's job.
  if (location.mode !== 'embedded') {
    return {
      ok: false,
      committed: false,
      error: 'An external brain is disconnected, not removed'
    }
  }
  const brainRoot = location.root
  if (!isBrainInitialized(location)) {
    return { ok: false, committed: false, error: 'There is no company brain here' }
  }

  const plan = await planBrainRemoval(location)

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
      await gitExecFileAsync(['rm', '-r', '-f', '--quiet', '--', location.pathspec], {
        cwd: location.gitRoot
      })
      await gitExecFileAsync(['commit', '-m', REMOVAL_MESSAGE, '--', location.pathspec], {
        cwd: location.gitRoot
      })
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

/**
 * Let go of an external brain without touching it.
 *
 * Removal in embedded mode deletes files, because they are this repo's. An
 * external brain may be shared by every repo the company opens, and the blast
 * radius of deleting it is not visible from the button. So this drops the
 * pointer and the binding, prunes the links the agent would be left holding,
 * and stops there.
 */
export function disconnectBrain(
  repoPath: string,
  options: { bindingsFile?: string } = {}
): BrainRemovalResult {
  // Read before the binding goes: afterwards there is nothing left to say which
  // brain these links lead into, and a live one's links prune away as healthy.
  const location = requireBrainLocation(repoPath, options)
  try {
    removeBrainPointer(repoPath)
    unbindRepo(repoPath, options.bindingsFile)
  } catch (error) {
    return { ok: false, committed: false, error: message(error) }
  }
  if (location?.mode === 'external') {
    unlinkBrainSkills(repoPath, location)
  }
  pruneDanglingSkillLinks(repoPath)
  return { ok: true, committed: false }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
