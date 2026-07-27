import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { BrainLocation, BrainResolution } from '../../shared/buildex-brain-types'
import { readBrainBindings } from './brain-bindings'
import { BRAIN_ROOT } from './company-brain-scan'

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

export function externalLocation(brainPath: string, remote?: string): BrainLocation {
  return {
    root: brainPath,
    gitRoot: brainPath,
    pathspec: '.',
    mode: 'external',
    ...(remote ? { remote } : {})
  }
}

/** `git@github.com:acme/brain.git` -> `~/.buildex/brains/brain`. */
export function suggestedClonePath(remote: string): string {
  const name =
    remote
      .replace(/\.git$/i, '')
      .split(/[/:]/)
      .toReversed()
      .find(Boolean) ?? 'brain'
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

  const remote = readBrainPointer(repoPath)
  if (remote) {
    const clone = bindings.clonesByRemote[remote]
    if (!clone) {
      return { status: 'needs-clone', remote, suggestedPath: suggestedClonePath(remote) }
    }
    return checkExternal(clone, remote)
  }

  const bound = bindings.brainByRepo[repoPath] ?? bindings.defaultBrainPath
  if (bound) {
    return checkExternal(bound)
  }

  return { status: 'ready', location: embeddedLocation(repoPath) }
}

/** The location, or null when the brain cannot be used until the operator acts. */
export function requireBrainLocation(
  repoPath: string,
  options: BrainResolveOptions = {}
): BrainLocation | null {
  const resolution = resolveBrainLocation(repoPath, options)
  return resolution.status === 'ready' ? resolution.location : null
}
