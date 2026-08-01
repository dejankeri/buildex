import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  BrainBindRequest,
  BrainBindResult,
  BrainLocation,
  BrainResolution
} from '../../shared/buildex-brain-types'
import { gitExecFileAsync } from '../git/runner'
import { relinkBrainSkills } from './skill-link'
import { bindRepoToBrain, readBrainBindings, rememberClone } from './brain-bindings'
import { BRAIN_ROOT, isBrainInitialized } from './company-brain-scan'
import { primaryCheckoutPath } from './worktree-primary-checkout'

// Where this repo's brain is. The only module that answers that question.
//
// Three answers, in order. A pointer tracked in the repo is the company's
// choice and travels with a clone, so it wins. A machine-local binding is one
// person's, and exists for companies who want nothing of BuildEx's committed.
// Neither: the brain is `.buildex/` in the repo, which is what it has always
// been and what almost every repo will keep using.
//
// The pointer records a remote rather than a path, because a path is only true
// on the machine that wrote it, and a pointer that breaks on a teammate's clone
// is worse than none.

export const BRAIN_POINTER_RELATIVE_PATH = '.buildex/brain.json'

type BrainResolveOptions = { bindingsFile?: string }

function pointerPath(repoPath: string): string {
  return path.join(repoPath, ...BRAIN_POINTER_RELATIVE_PATH.split('/'))
}

export function readBrainPointer(repoPath: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(pointerPath(repoPath), 'utf8'))
    if (!raw || typeof raw !== 'object') {
      return null
    }
    const remote = (raw as Record<string, unknown>).remote
    return typeof remote === 'string' && remote.trim() ? remote.trim() : null
  } catch {
    return null
  }
}

export function writeBrainPointer(repoPath: string, remote: string): void {
  const file = pointerPath(repoPath)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ remote }, null, 2)}\n`, 'utf8')
}

export function removeBrainPointer(repoPath: string): void {
  try {
    rmSync(pointerPath(repoPath), { force: true })
  } catch {
    // Already gone, or not ours to remove.
  }
}

export function embeddedLocation(repoPath: string): BrainLocation {
  return {
    root: path.join(repoPath, BRAIN_ROOT),
    gitRoot: repoPath,
    pathspec: BRAIN_ROOT,
    mode: 'embedded'
  }
}

/**
 * The primary checkout, when this machine can actually reach it.
 *
 * Null for a checkout that has none — a folder workspace, a worktree of a bare
 * repo — and for one whose main clone has moved or gone, where converging would
 * point the brain at a path that is not there.
 */
function reachablePrimaryCheckout(checkoutPath: string): string | null {
  const primary = primaryCheckoutPath(checkoutPath)
  return primary && existsSync(primary) ? primary : null
}

/**
 * The checkout a placement decision — a pointer, a binding — is recorded in.
 *
 * Always the primary one, because the fallback that finds them reads worktree
 * then primary and never the reverse: a decision recorded in a worktree is
 * visible from that worktree alone, while every sibling carries on resolving
 * somewhere else. That is the company's brain split in two.
 */
export function brainPlacementCheckout(checkoutPath: string): string {
  return reachablePrimaryCheckout(checkoutPath) ?? checkoutPath
}

/**
 * The one checkout whose `.buildex/` is this company's embedded brain.
 *
 * `.buildex/` is branch content, so N parallel agent worktrees would otherwise
 * each see whatever snapshot their branch was cut from and save onto that
 * branch — the brain fragments exactly when the operator parallelises, which is
 * the point of the tool. So every checkout of a repo converges on the primary
 * one, the same aliasing `resolveBrainLocation` already applies to pointers and
 * bindings. One rule, one resolver.
 *
 * One exception, and it is about not losing anybody's writing. Before this rule
 * existed every save from a worktree landed on that worktree's branch — so the
 * population upgrading into it is precisely "worktrees holding documents the
 * primary checkout has never seen". Converging those onto a brainless primary
 * would orphan them: the brain would read as empty, `embeddedBrainPresent` would
 * go false, and the placement UI would offer *bind* ("nothing to move") instead
 * of *migrate*, so they could not even be moved out. A checkout with a brain
 * therefore keeps it while the primary has none, and converges the moment the
 * primary has one.
 */
export function embeddedBrainCheckout(checkoutPath: string): string {
  const primary = reachablePrimaryCheckout(checkoutPath)
  if (!primary) {
    return checkoutPath
  }
  if (isBrainInitialized(embeddedLocation(primary))) {
    return primary
  }
  return isBrainInitialized(embeddedLocation(checkoutPath)) ? checkoutPath : primary
}

export function externalLocation(brainPath: string, remote?: string): BrainLocation {
  return {
    root: brainPath,
    gitRoot: brainPath,
    pathspec: '.',
    mode: 'external',
    ...(remote ? { remote } : {})
  }
}

/**
 * `git@github.com:acme/brain.git` -> `~/.buildex/brains/brain`.
 *
 * `.` and `..` are skipped rather than used: the remote comes from a tracked
 * file this machine did not write, and a name of `..` normalises the suggested
 * path up out of `brains/` — one that ends `/..` would offer `~/.buildex`.
 */
export function suggestedClonePath(remote: string): string {
  const name =
    remote
      .replace(/\.git$/i, '')
      .split(/[/:\\]/)
      .toReversed()
      .find((segment) => segment && segment !== '.' && segment !== '..') ?? 'brain'
  return path.join(homedir(), '.buildex', 'brains', name)
}

function checkExternal(brainPath: string, remote?: string): BrainResolution {
  if (!existsSync(brainPath)) {
    return { status: 'broken', reason: 'missing', path: brainPath }
  }
  // Why: `.git` is a directory in a clone and a file in a worktree; either is a
  // repo. Cheaper and more predictable than shelling out to git on every scan.
  if (!existsSync(path.join(brainPath, '.git'))) {
    return { status: 'broken', reason: 'not-a-repo', path: brainPath }
  }
  return { status: 'ready', location: externalLocation(brainPath, remote) }
}

export function resolveBrainLocation(
  repoPath: string,
  options: BrainResolveOptions = {}
): BrainResolution {
  const bindings = readBrainBindings(options.bindingsFile)
  // A worktree is the same repo at another path: a binding keyed to the path the
  // brain was set up in does not name it, and a pointer that was never committed
  // is not in its checkout. Falling back to the primary checkout is what makes an
  // external brain visible from every worktree, which is the whole expectation of
  // a company that keeps its brain outside the code repo.
  const primary = primaryCheckoutPath(repoPath)

  const remote = readBrainPointer(repoPath) ?? (primary ? readBrainPointer(primary) : null)
  if (remote) {
    const clone = bindings.clonesByRemote[remote]
    if (!clone) {
      return { status: 'needs-clone', remote, suggestedPath: suggestedClonePath(remote) }
    }
    return checkExternal(clone, remote)
  }

  const bound =
    bindings.brainByRepo[repoPath] ?? (primary ? bindings.brainByRepo[primary] : undefined)
  if (bound) {
    return checkExternal(bound)
  }

  // Embedded converges on the primary checkout — see `embeddedBrainCheckout`.
  // The location carries that path as its `gitRoot`, so a save from a worktree
  // stages and commits there rather than on the feature branch.
  return { status: 'ready', location: embeddedLocation(embeddedBrainCheckout(repoPath)) }
}

/** The location, or null when the brain cannot be used until the operator acts. */
export function requireBrainLocation(
  repoPath: string,
  options: BrainResolveOptions = {}
): BrainLocation | null {
  const resolution = resolveBrainLocation(repoPath, options)
  return resolution.status === 'ready' ? resolution.location : null
}

/**
 * Point a repo at a brain that already exists — no copying, no committing, no
 * scaffolding. `migrateBrainToExternal` moves an embedded brain out; this is
 * what a repo with nothing embedded to move needs instead, most often a brand
 * new company whose first choice is a brain repo of its own.
 *
 * Same `writePointer` choice migrate honours: a tracked pointer plus a
 * remembered clone when the operator asked for one and gave a remote, a
 * machine-local binding otherwise.
 */
export async function bindExistingBrain(
  request: BrainBindRequest & { bindingsFile?: string }
): Promise<BrainBindResult> {
  const { brainPath, remote, writePointer, bindingsFile } = request
  // Recorded in the primary checkout, or a bind issued from a worktree is
  // visible from that worktree alone while the primary and every sibling carry
  // on resolving embedded — the company's brain split in two, through the door
  // migrate had already been closed at.
  const repoPath = brainPlacementCheckout(request.repoPath)
  if (!existsSync(brainPath)) {
    return { ok: false, error: `${brainPath} does not exist` }
  }
  if (!existsSync(path.join(brainPath, '.git'))) {
    return { ok: false, error: `${brainPath} is not a git repo` }
  }
  if (writePointer && remote) {
    writeBrainPointer(repoPath, remote)
    rememberClone(remote, brainPath, bindingsFile)
    try {
      // Staged, not committed — the operator asked for a pointer, and a pointer
      // is only the company's choice once it is in the repo's history. Same
      // contract as migrate: the commit is theirs to make.
      await gitExecFileAsync(['add', '--', BRAIN_POINTER_RELATIVE_PATH], { cwd: repoPath })
    } catch {
      // No git here, or nothing to stage. The pointer is on disk either way and
      // still resolves on this machine.
    }
  } else {
    bindRepoToBrain(repoPath, brainPath, bindingsFile)
  }
  // The brain's skills are the company's, and binding is the moment this repo
  // gains them: without the links the agent here sees none of them, ever. Both
  // checkouts hold their own `.claude/`, and only one of them is on screen.
  for (const checkout of new Set([request.repoPath, repoPath])) {
    relinkBrainSkills(checkout, externalLocation(brainPath, remote))
  }
  return { ok: true }
}
