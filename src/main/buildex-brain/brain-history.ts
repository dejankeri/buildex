import path from 'node:path'
import { gitExecFileAsync } from '../git/runner'
import type {
  BrainHistoryResult,
  BrainLocation,
  BrainSave,
  BrainSaveResult
} from '../../shared/buildex-brain-types'

// The brain's history, and the one action that adds to it.
//
// Git already is the version store — that is the point of keeping the brain as
// files. So this reads `git log -- <pathspec>` against the brain's own git root
// and renders it, rather than keeping a parallel record that could disagree
// with the repo.
//
// Saving commits ONLY the brain's pathspec. An operator naming a snapshot of
// their company's thinking should not sweep up whatever else is in the working
// tree; in an embedded, mixed repo that would quietly commit code someone was
// still writing.

// Why: separators that cannot appear in a commit subject, so the log parses
// exactly instead of heuristically. The ASCII unit and record separators are
// what they are for.
const FIELD = '\x1f'
const RECORD = '\x1e'

// Embedded mode's pathspec is a prefix to strip; external's `.` already yields
// brain-relative paths, and stripping there would eat the first path segment.
function toBrainRelative(location: BrainLocation, repoRelative: string): string {
  if (location.pathspec === '.') {
    return repoRelative
  }
  const prefix = `${location.pathspec}/`
  return repoRelative.startsWith(prefix) ? repoRelative.slice(prefix.length) : repoRelative
}

export function parseBrainLog(location: BrainLocation, stdout: string): BrainSave[] {
  const saves: BrainSave[] = []
  for (const record of stdout.split(RECORD)) {
    const trimmed = record.trim()
    if (!trimmed) {
      continue
    }
    const [header, ...pathLines] = trimmed.split('\n')
    const [hash, shortHash, subject, author, timestamp] = header.split(FIELD)
    if (!hash) {
      continue
    }
    saves.push({
      hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      subject: subject?.trim() || '(no name)',
      author: author ?? '',
      timestamp: Number.parseInt(timestamp ?? '0', 10) || 0,
      changedPaths: [
        ...new Set(
          pathLines
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => toBrainRelative(location, line))
        )
      ].sort()
    })
  }
  return saves
}

/** Brain-relative paths with uncommitted changes. */
export async function readUnsavedBrainPaths(location: BrainLocation): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['status', '--porcelain', '-z', '--untracked-files=all', '--', location.pathspec],
      { cwd: location.gitRoot }
    )
    return stdout
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => toBrainRelative(location, entry.slice(3)))
      .sort()
  } catch {
    return []
  }
}

export async function readBrainHistory(
  location: BrainLocation,
  limit = 50
): Promise<BrainHistoryResult> {
  try {
    const { stdout } = await gitExecFileAsync(
      [
        'log',
        `--max-count=${limit}`,
        `--format=${RECORD}%H${FIELD}%h${FIELD}%s${FIELD}%an${FIELD}%at`,
        '--name-only',
        '--',
        location.pathspec
      ],
      { cwd: location.gitRoot }
    )
    return {
      saves: parseBrainLog(location, stdout),
      unavailable: false,
      unsavedPaths: await readUnsavedBrainPaths(location)
    }
  } catch {
    // No git, or a repo with no commits yet. Saying so beats an empty list that
    // reads like the history was lost.
    return { saves: [], unavailable: true, unsavedPaths: [] }
  }
}

export async function commitBrain(
  location: BrainLocation,
  message: string
): Promise<BrainSaveResult> {
  const subject = message.trim()
  if (!subject) {
    return { ok: false, savedPaths: [], error: 'Give this save a name' }
  }
  const savedPaths = await readUnsavedBrainPaths(location)
  if (savedPaths.length === 0) {
    return { ok: false, savedPaths: [], error: 'Nothing has changed since the last save' }
  }
  try {
    // Pathspec-scoped throughout: stage and commit the brain and nothing else,
    // however dirty the rest of the working tree is.
    await gitExecFileAsync(['add', '--', location.pathspec], { cwd: location.gitRoot })
    await gitExecFileAsync(['commit', '-m', subject, '--', location.pathspec], {
      cwd: location.gitRoot
    })
    return { ok: true, savedPaths }
  } catch (error) {
    return {
      ok: false,
      savedPaths: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Absolute path of a brain document, for opening it in the editor. */
export function brainDocumentPath(location: BrainLocation, documentId: string): string {
  return path.join(location.root, ...documentId.split('/'))
}
