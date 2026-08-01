import { cpSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import type { BrainLocation, BrainMigrationResult } from '../../shared/buildex-brain-types'
import { gitExecFileAsync } from '../git/runner'
import { relinkBrainSkills } from './skill-link'
import { BACKUP_ROOT, backupStamp } from './brain-remove'
import { bindRepoToBrain, rememberClone } from './brain-bindings'
import { commitBrain } from './brain-history'
import {
  BRAIN_POINTER_RELATIVE_PATH,
  embeddedBrainCheckout,
  embeddedLocation,
  externalLocation,
  writeBrainPointer
} from './brain-location'
import { listBrainDocumentPaths } from './company-brain-scan'

// Taking a brain that grew up inside a code repo and giving it a repo of its own.
//
// The order is the safety: back up first, write the new copy second, remove the
// old one last. A failure at any point leaves the operator with at least one
// complete brain, and usually two.

export type BrainMigrationRequest = {
  repoPath: string
  brainPath: string
  remote?: string
  /** Write `.buildex/brain.json` so teammates find the brain too. */
  writePointer: boolean
  bindingsFile?: string
}

const MIGRATION_MESSAGE = 'Moved the company brain into its own repo'

export async function migrateBrainToExternal(
  request: BrainMigrationRequest,
  now: number
): Promise<BrainMigrationResult> {
  // The embedded brain a worktree shows is the primary checkout's, so that is
  // the one being moved — and the checkout every git command, the pointer and
  // the binding below must name. Asked once here so they cannot disagree.
  const repoPath = embeddedBrainCheckout(request.repoPath)
  const source = embeddedLocation(repoPath)
  const target = externalLocation(request.brainPath, request.remote)

  // Checked before anything else is computed: a scan of a brain that isn't
  // there yields an empty list rather than an error, which would make the
  // failure read as "there was nothing to move" instead of "there is no brain".
  if (!existsSync(source.root)) {
    return { ok: false, movedPaths: [], error: 'There is no brain here to move' }
  }
  const movedPaths = listBrainDocumentPaths(source)

  let backupPath: string
  try {
    backupPath = path.join(BACKUP_ROOT, `${path.basename(repoPath)}-${backupStamp(now)}`)
    mkdirSync(backupPath, { recursive: true })
    cpSync(source.root, backupPath, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      movedPaths: [],
      error: `Could not back the brain up, so nothing moved: ${message(error)}`
    }
  }

  const owned = brainOwnedEntries(source)
  try {
    for (const relative of owned) {
      const to = path.join(target.root, ...relative.split('/'))
      mkdirSync(path.dirname(to), { recursive: true })
      cpSync(path.join(source.root, ...relative.split('/')), to, { recursive: true })
    }
    // commitBrain signals failure by return value, not by throwing — an unset
    // git identity or an empty diff must stop this before the source is touched.
    const committed = await commitBrain(target, MIGRATION_MESSAGE)
    if (!committed.ok) {
      return { ok: false, backupPath, movedPaths: [], error: committed.error }
    }
  } catch (error) {
    return { ok: false, backupPath, movedPaths: [], error: message(error) }
  }

  const pathspecs = owned.map((relative) => `${source.pathspec}/${relative}`)
  try {
    // --ignore-unmatch because the pathspecs are now per-file: one document the
    // operator never saved would otherwise fail the whole command, and none of
    // the tracked ones would be staged for removal.
    await gitExecFileAsync(['rm', '-r', '-f', '--ignore-unmatch', '--quiet', '--', ...pathspecs], {
      cwd: repoPath
    })
  } catch {
    // No git here at all: the plain removal below still applies.
  }
  try {
    for (const relative of owned) {
      rmSync(path.join(source.root, ...relative.split('/')), { recursive: true, force: true })
    }
    removeEmptyDirectories(source.root)
  } catch (error) {
    return { ok: false, backupPath, movedPaths, error: message(error) }
  }

  try {
    if (request.writePointer && request.remote) {
      writeBrainPointer(repoPath, request.remote)
      rememberClone(request.remote, request.brainPath, request.bindingsFile)
      try {
        await gitExecFileAsync(['add', '--', BRAIN_POINTER_RELATIVE_PATH], {
          cwd: repoPath
        })
      } catch {
        // The pointer is on disk either way; an uncommitted one still resolves.
      }
    } else {
      bindRepoToBrain(repoPath, request.brainPath, request.bindingsFile)
    }
  } catch (error) {
    // The files have already moved, so the one thing the operator must not be
    // left guessing at is where they went.
    return {
      ok: false,
      backupPath,
      movedPaths,
      error: `The brain is now in ${request.brainPath}, but this repo could not be pointed at it: ${message(error)}`
    }
  }

  try {
    // Committed either way: `git rm` only staged the removal, and the code
    // repo's HEAD must lose the brain even when the operator declined a pointer.
    await gitExecFileAsync(['commit', '-m', MIGRATION_MESSAGE, '--', source.pathspec], {
      cwd: repoPath
    })
  } catch {
    // No git, or nothing staged for this pathspec: the files are gone from
    // disk regardless, and there was nothing left to commit.
  }

  // Every link in `.claude/skills/` pointed into the folder just emptied, and a
  // dangling one is invisible to the agent and to every later install. Both
  // checkouts hold their own `.claude/`, and only one of them is on screen.
  for (const checkout of new Set([request.repoPath, repoPath])) {
    relinkBrainSkills(checkout, target)
  }

  return { ok: true, backupPath, movedPaths }
}

/**
 * What the brain owns, brain-relative: its documents and `skills/`.
 *
 * Deliberately not "everything in `.buildex/`". The folder is also where the
 * company's gate preset lives, and that is read from the code repo in both
 * modes — moving it would silently swap the agent's permission policy for the
 * shipped default.
 */
function brainOwnedEntries(source: BrainLocation): string[] {
  const owned = listBrainDocumentPaths(source)
  if (existsSync(path.join(source.root, 'skills'))) {
    owned.push('skills')
  }
  return owned
}

/**
 * Tidy the folders the moved documents lived in, deepest first. `root` itself
 * stays: in external mode `.buildex/` is where the pointer goes.
 */
function removeEmptyDirectories(root: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const child = path.join(root, entry.name)
    removeEmptyDirectories(child)
    try {
      // rmdir, not a recursive delete: if the emptiness check were ever wrong,
      // this refuses where rm -r would take the contents with it.
      rmdirSync(child)
    } catch {
      // Not empty, or gone already.
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
