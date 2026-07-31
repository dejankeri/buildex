import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { primaryCheckoutPath } from './buildex-brain/worktree-primary-checkout'

// Which business a path belongs to.
//
// One operator runs N businesses in parallel, so anything BuildEx stores per
// business needs a name for it that two paths into the same business agree on.
// A worktree path is not that name: a company with four worktrees would be four
// businesses, and its Stripe key would split four ways with no error to notice.
//
// A company is a git repository — that is BuildEx's model of a business, and it
// is also the only identity available that survives `git worktree add`. A folder
// that is not inside a repo is not a company: it has no brain, no gate, and
// nothing of its own to isolate, so it gets none of anybody's keys.
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
  /** The repo's primary checkout — the same path from every worktree of it. */
  root: string
  /** Filesystem-safe name for this company's slice of machine-local state. */
  key: string
}

/**
 * The company this path belongs to, or null when it belongs to none.
 *
 * Null is a normal answer, not an error: a scratch folder, a path this machine
 * cannot see (an SSH workspace names the *remote* filesystem), or a directory
 * outside any repo.
 */
export function resolveCompanyIdentity(
  workspacePath: string | null | undefined
): CompanyIdentity | null {
  const checkout = enclosingCheckout(workspacePath)
  if (!checkout) {
    return null
  }
  // A linked worktree is the same business at another path; the primary checkout
  // is the one name all of them share.
  const root = canonicalPath(primaryCheckoutPath(checkout) ?? checkout)
  return { root, key: `${slugFor(path.basename(root))}-${digestOf(root)}` }
}

/**
 * The nearest enclosing checkout, so a terminal opened in `packages/api` is the
 * same company as one opened at the root.
 *
 * A path this machine does not have is not a checkout to walk up from — that is
 * what keeps a remote workspace's path from matching an unrelated local folder.
 */
function enclosingCheckout(workspacePath: string | null | undefined): string | null {
  if (!workspacePath?.trim()) {
    return null
  }
  let dir = path.resolve(workspacePath)
  if (!existsSync(dir)) {
    return null
  }
  for (;;) {
    // `.git` is a directory in a clone and a file in a linked worktree; either is
    // a checkout, and neither costs a git process to recognise.
    if (existsSync(path.join(dir, '.git'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      return null
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
