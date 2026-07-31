import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { primaryCheckoutPath } from './buildex-brain/worktree-primary-checkout'

// Which business a path belongs to.
//
// One operator runs N businesses in parallel, so anything BuildEx stores per
// business needs a name for it that two paths into the same business agree on.
// A worktree path is not that name: a company with four worktrees would be four
// businesses, and its Stripe key would split four ways with no error to notice.
//
// Two shapes of business, one derivation. A git repo is named by its primary
// checkout, which is the only identity that survives `git worktree add`. A
// folder workspace outside any repo has no aliasing to undo — the path *is* the
// identity — so it is named by itself. Both then go through the same slug and
// digest, so there is one format and one filesystem-safety argument.
//
// What is not a company is a path this machine does not have. An SSH workspace
// names the *remote* filesystem, and a local folder that happens to share that
// path is a different directory; keying on it would file one business's key
// under another's name.
//
// The key is derived from this machine's path, which does NOT travel with a
// clone. That is correct rather than a compromise: what the key names is
// machine-local secret storage, and a secret never travels either. Two machines
// with the same repo hold different keys behind the same plugin, which is what
// an operator with a laptop and a desktop actually has.

/** Kept short: this is a directory name inside userData, not an identifier anyone types. */
const KEY_HASH_LENGTH = 16
const SLUG_MAX_LENGTH = 24

export type CompanyIdentity = {
  /**
   * What the key names: a repo's primary checkout — the same path from every
   * worktree of it — or, for a folder workspace outside any repo, itself.
   */
  root: string
  /** Filesystem-safe name for this company's slice of machine-local state. */
  key: string
}

/**
 * The company this path belongs to, or null when this machine cannot see it.
 *
 * Null is one case only, and it is a normal answer rather than an error: the
 * caller gave no path, or gave one that is not on this machine — which is what a
 * remote (SSH) workspace's path is. Every local directory is some business.
 */
export function resolveCompanyIdentity(
  workspacePath: string | null | undefined
): CompanyIdentity | null {
  if (!workspacePath?.trim()) {
    return null
  }
  if (!existsSync(path.resolve(workspacePath))) {
    return null
  }
  // Canonicalised before the walk, not after: the home-directory bound below is a
  // path comparison, and `~/Work` given as `~/work` would slip past it on a
  // case-insensitive filesystem.
  const workspace = canonicalPath(path.resolve(workspacePath))
  const checkout = enclosingCheckout(workspace)
  // In a repo, a linked worktree is the same business at another path and the
  // primary checkout is the one name they share. Outside one there is no such
  // aliasing to undo, so a folder workspace is named by itself.
  const root = canonicalPath(checkout ? (primaryCheckoutPath(checkout) ?? checkout) : workspace)
  return { root, key: `${slugFor(path.basename(root))}-${digestOf(root)}` }
}

/**
 * The nearest enclosing checkout, so a terminal opened in `packages/api` is the
 * same company as one opened at the repo root. Null outside a repo, where there
 * is no boundary to walk up to and the workspace path stands for itself.
 *
 * The walk stops at the home directory and at the filesystem root, and tests
 * neither. `git init ~` is an ordinary dotfiles setup, and a repo that encloses
 * every business would collapse all of them into one — pooling the credentials
 * of businesses that have nothing to do with each other. A false *merge* is the
 * worse error here, so the bound is deliberate, not a guard against runaway
 * loops.
 */
function enclosingCheckout(workspace: string): string | null {
  const home = canonicalPath(homedir())
  let dir = workspace
  for (;;) {
    const parent = path.dirname(dir)
    if (dir === home || parent === dir) {
      return null
    }
    // `.git` is a directory in a clone and a file in a linked worktree; either is
    // a checkout, and neither costs a git process to recognise.
    if (existsSync(path.join(dir, '.git'))) {
      return dir
    }
    dir = parent
  }
}

/**
 * The one spelling of a directory this machine agrees on.
 *
 * `realpath` resolves symlinks (`/tmp` is `/private/tmp` on macOS) and returns
 * the on-disk casing, so a repo reached as `~/Work/acme` and as `~/work/acme` is
 * one company on a case-insensitive filesystem rather than two.
 */
function canonicalPath(target: string): string {
  try {
    return realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * A readable prefix so the folder is recognisable when an operator looks.
 *
 * Lowercase `[a-z0-9-]` only, which is legal on APFS, ext4 and NTFS alike. No
 * dot, so Windows cannot read a reserved device name out of it, and the hash
 * suffix means the whole name is never `con` or `lpt1` either.
 */
function slugFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, '')
  return slug || 'company'
}

/** Not lowercased before hashing: on Linux `/srv/Acme` and `/srv/acme` are two businesses. */
function digestOf(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, KEY_HASH_LENGTH)
}
