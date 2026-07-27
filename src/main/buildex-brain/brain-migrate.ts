import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { gitExecFileAsync } from '../git/runner'
import { BACKUP_ROOT, backupStamp } from './brain-remove'
import { bindRepoToBrain, rememberClone } from './brain-bindings'
import { commitBrain } from './brain-history'
import {
  BRAIN_POINTER_RELATIVE_PATH,
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

export type BrainMigrationResult = {
  ok: boolean
  backupPath?: string
  /** Brain-relative paths now in the brain repo, sorted. */
  movedPaths: string[]
  error?: string
}

const MIGRATION_MESSAGE = 'Moved the company brain into its own repo'

export async function migrateBrainToExternal(
  request: BrainMigrationRequest,
  now: number
): Promise<BrainMigrationResult> {
  const source = embeddedLocation(request.repoPath)
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
    backupPath = path.join(BACKUP_ROOT, `${path.basename(request.repoPath)}-${backupStamp(now)}`)
    mkdirSync(backupPath, { recursive: true })
    cpSync(source.root, backupPath, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      movedPaths: [],
      error: `Could not back the brain up, so nothing moved: ${message(error)}`
    }
  }

  try {
    // Everything except the pointer, which belongs to the code repo.
    cpSync(source.root, target.root, {
      recursive: true,
      filter: (from) => path.basename(from) !== 'brain.json'
    })
    await commitBrain(target, MIGRATION_MESSAGE)
  } catch (error) {
    return { ok: false, backupPath, movedPaths: [], error: message(error) }
  }

  try {
    await gitExecFileAsync(['rm', '-r', '-f', '--quiet', '--', source.pathspec], {
      cwd: request.repoPath
    })
  } catch {
    // Untracked, or no git here: the plain removal below still applies.
  }
  try {
    rmSync(source.root, { recursive: true, force: true })
  } catch (error) {
    return { ok: false, backupPath, movedPaths, error: message(error) }
  }

  if (request.writePointer && request.remote) {
    writeBrainPointer(request.repoPath, request.remote)
    rememberClone(request.remote, request.brainPath, request.bindingsFile)
    try {
      await gitExecFileAsync(['add', '--', BRAIN_POINTER_RELATIVE_PATH], { cwd: request.repoPath })
    } catch {
      // The pointer is on disk either way; an uncommitted one still resolves.
    }
  } else {
    bindRepoToBrain(request.repoPath, request.brainPath, request.bindingsFile)
  }

  try {
    // Committed either way: `git rm` only staged the removal, and the code
    // repo's HEAD must lose the brain even when the operator declined a pointer.
    await gitExecFileAsync(['commit', '-m', MIGRATION_MESSAGE, '--', source.pathspec], {
      cwd: request.repoPath
    })
  } catch {
    // No git, or nothing staged for this pathspec: the files are gone from
    // disk regardless, and there was nothing left to commit.
  }

  return { ok: true, backupPath, movedPaths }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
