import { existsSync } from 'node:fs'
import path from 'node:path'
import { gitExecFileAsync } from '../git/runner'

// Why a checkout cannot take a brain commit right now.
//
// Two failure shapes, and they fail in opposite directions — which is why both
// live here rather than being left to git.
//
// A merge, rebase, cherry-pick or revert makes git refuse the *partial* commit a
// brain save is (`git commit -- <pathspec>`). The `git add` in front of it does
// not refuse, so an unguarded save leaves the brain's files staged inside the
// operator's conflicted index, where the commit that finishes their merge sweeps
// them up. That is the code-and-brain mixing pathspec scoping exists to prevent,
// arrived at from the other side.
//
// A detached HEAD is the reverse: git accepts the commit and nothing warns. The
// save reports success and the commit becomes unreachable the moment the
// operator checks a branch out again. `git bisect` and a tag checkout are both
// this case.
//
// Both matter more since an embedded brain converged on the primary checkout: a
// save from a worktree commits in a checkout the operator is not looking at, and
// the state it is in is not on their screen.

export type CheckoutCommitBlock = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'detached-head'

// Marker files in the checkout's own git dir. Every name here predates Git 2.25.
// `rebase-apply` is `git am`'s too — close enough to name it a rebase, since
// what the operator has to do about it is the same.
const MARKERS: readonly (readonly [string, CheckoutCommitBlock])[] = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert']
]

/** Null when the checkout can take the commit, is no repo, or git cannot say. */
export async function readCheckoutCommitBlock(
  gitRoot: string
): Promise<CheckoutCommitBlock | null> {
  let gitDir = ''
  try {
    const { stdout } = await gitExecFileAsync(['rev-parse', '--git-dir'], { cwd: gitRoot })
    gitDir = stdout.trim()
  } catch {
    // No git, or no repo here. Nothing to block, and nothing we could tell the
    // operator to go fix.
    return null
  }
  if (!gitDir) {
    return null
  }
  // `--git-dir` answers a bare `.git` in an ordinary checkout and an absolute
  // path in a linked worktree; resolving covers both. Each checkout gets its own
  // dir, which is why this reports the state of *this* one and not the repo's.
  const resolved = path.resolve(gitRoot, gitDir)
  const operation = MARKERS.find(([marker]) => existsSync(path.join(resolved, marker)))?.[1]
  if (operation) {
    // Reported ahead of the detached HEAD a rebase also leaves, because it is
    // the thing the operator has to resolve and the branch comes back with it.
    return operation
  }

  try {
    // `-q` so a detached HEAD is a non-zero exit rather than stderr noise. An
    // unborn branch still resolves to `refs/heads/<name>`, and committing there
    // is fine — it is what the first commit in a repo does.
    const { stdout } = await gitExecFileAsync(['symbolic-ref', '-q', 'HEAD'], { cwd: gitRoot })
    return stdout.trim() ? null : 'detached-head'
  } catch {
    return 'detached-head'
  }
}

/** Why the write stopped, in terms of the checkout the operator has to go fix. */
export function checkoutCommitBlockMessage(block: CheckoutCommitBlock, gitRoot: string): string {
  if (block === 'detached-head') {
    return `${gitRoot} has no branch checked out. Check one out there first — the brain commits in that checkout, and a commit made on a detached HEAD is unreachable as soon as it moves.`
  }
  return `A ${block} is in progress in ${gitRoot}. Finish or abort it first — the brain commits in that checkout, and Git cannot commit the brain alone mid-${block}.`
}
