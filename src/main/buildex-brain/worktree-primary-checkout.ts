import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// A linked worktree is the same repo at a different path with a fresh checkout.
// Anything the brain keyed to the path it was set up in — a machine-local
// binding, an uncommitted pointer — is invisible from there, so the resolver
// needs a way back to the checkout that has it.
//
// Read from `.git` rather than `git rev-parse --git-common-dir`: resolution runs
// on every brain scan and is synchronous, and shelling out per scan would make
// it neither.

/**
 * The primary checkout of the repo this path belongs to, or null when it is
 * already the primary one, is not a checkout, or the repo has none (bare).
 *
 * A linked worktree's `.git` is a file reading
 * `gitdir: <primary>/.git/worktrees/<name>`.
 */
export function primaryCheckoutPath(checkoutPath: string): string | null {
  const dotGit = path.join(checkoutPath, '.git')
  let content: string
  try {
    if (statSync(dotGit).isDirectory()) {
      return null
    }
    content = readFileSync(dotGit, 'utf8')
  } catch {
    return null
  }

  const gitDir = content.match(/^gitdir:\s*(.+?)\s*$/m)?.[1]
  if (!gitDir) {
    return null
  }
  const resolved = path.resolve(checkoutPath, gitDir)

  // Anything else with a `.git` file — `git init --separate-git-dir`, a
  // submodule — is not a linked worktree and has no primary checkout to offer.
  const worktreesDir = path.dirname(resolved)
  if (path.basename(worktreesDir) !== 'worktrees') {
    return null
  }
  const commonDir = path.dirname(worktreesDir)
  // A bare repo's common dir is the repo itself, and its parent is whatever
  // folder happens to contain it — not a checkout, and not somewhere to look
  // for a pointer file.
  if (path.basename(commonDir) !== '.git') {
    return null
  }

  const primary = path.dirname(commonDir)
  return primary === checkoutPath ? null : primary
}
