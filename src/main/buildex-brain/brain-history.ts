import { gitExecFileAsync } from '../git/runner'
import type {
  BrainHistoryResult,
  BrainLocation,
  BrainSave,
  BrainSaveResult
} from '../../shared/buildex-brain-types'
import { readChangedBrainPaths, toBrainRelative } from './brain-git-paths'
import { pushBrain, reportPush } from './brain-sync'

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
      unsavedPaths: await readChangedBrainPaths(location)
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
  const savedPaths = await readChangedBrainPaths(location)
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

/** Commit, then share. A failed push never costs the operator the commit. */
export async function saveBrain(
  location: BrainLocation,
  message: string
): Promise<BrainSaveResult> {
  const committed = await commitBrain(location, message)
  if (!committed.ok || location.mode === 'embedded') {
    return committed
  }
  // Mapped rather than spread: `error` on a save result means the save itself
  // failed, and a push that did not land never means that.
  const push = reportPush(await pushBrain(location))
  return {
    ...committed,
    pushed: push.pushed,
    ...(push.localOnly ? { localOnly: true } : {}),
    ...(push.error ? { pushError: push.error } : {})
  }
}
