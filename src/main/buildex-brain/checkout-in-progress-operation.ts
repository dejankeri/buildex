import { existsSync } from 'node:fs'
import path from 'node:path'
import { gitExecFileAsync } from '../git/runner'

// Whether a checkout is in the middle of a merge, rebase, cherry-pick or revert.
//
// A brain save is a *partial* commit — `git commit -- <pathspec>` — and git
// refuses one outright while any of those is unresolved. The `git add` in front
// of it does not refuse, so without this check a blocked save leaves the brain's
// files staged inside the operator's conflicted index, where the commit that
// finishes their merge sweeps them up. That is precisely the code-and-brain
// mixing pathspec scoping exists to prevent, arrived at from the other side.
//
// It matters more since an embedded brain converged on the primary checkout: a
// save from a worktree commits in a checkout the operator is not looking at, and
// the state it is in is not on their screen.

export type InProgressGitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

// Marker files in the checkout's own git dir. Every name here predates Git 2.25.
// `rebase-apply` is `git am`'s too — close enough to name it a rebase, since
// what the operator has to do about it is the same.
const MARKERS: readonly (readonly [string, InProgressGitOperation])[] = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert']
]

const LABELS: Record<InProgressGitOperation, string> = {
  merge: 'merge',
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert'
}

/** Null when the checkout is idle, is no repo, or git cannot say. */
export async function readInProgressGitOperation(
  gitRoot: string
): Promise<InProgressGitOperation | null> {
  let gitDir = ''
  try {
    const { stdout } = await gitExecFileAsync(['rev-parse', '--git-dir'], { cwd: gitRoot })
    gitDir = stdout.trim()
  } catch {
    // No git, or no repo here. Nothing can be mid-anything.
    return null
  }
  if (!gitDir) {
    return null
  }
  // `--git-dir` answers a bare `.git` in an ordinary checkout and an absolute
  // path in a linked worktree; resolving covers both. Each checkout gets its own
  // dir, which is why this reports the state of *this* one and not the repo's.
  const resolved = path.resolve(gitRoot, gitDir)
  return MARKERS.find(([marker]) => existsSync(path.join(resolved, marker)))?.[1] ?? null
}

/** Why the save stopped, in terms of the checkout the operator has to go fix. */
export function inProgressOperationMessage(
  operation: InProgressGitOperation,
  gitRoot: string
): string {
  const label = LABELS[operation]
  return `A ${label} is in progress in ${gitRoot}. Finish or abort it first — saving commits the brain there, and Git cannot commit the brain alone mid-${label}.`
}
