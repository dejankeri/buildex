import path from 'node:path'
import { gitExecFileAsync } from '../git/runner'
import type {
  BrainHistoryResult,
  BrainSave,
  BrainSaveResult
} from '../../shared/buildex-brain-types'
import { BRAIN_ROOT } from './company-brain-scan'

// The brain's history, and the one action that adds to it.
//
// Git already is the version store — that is the point of keeping the brain as
// files. So this reads `git log -- .buildex/` and renders it, rather than
// keeping a parallel record that could disagree with the repo.
//
// Saving commits ONLY `.buildex/`. An operator naming a snapshot of their
// company's thinking should not sweep up whatever else is in the working tree;
// in a mixed repo that would quietly commit code someone was still writing.

// Why: separators that cannot appear in a commit subject, so the log parses
// exactly instead of heuristically.  and  are the ASCII unit and
// record separators, which is what they are for.
const FIELD = ''
const RECORD = ''

function toBrainRelative(repoRelative: string): string {
  const prefix = `${BRAIN_ROOT}/`
  return repoRelative.startsWith(prefix) ? repoRelative.slice(prefix.length) : repoRelative
}

export function parseBrainLog(stdout: string): BrainSave[] {
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
            .map(toBrainRelative)
        )
      ].sort()
    })
  }
  return saves
}

/** Brain-relative paths with uncommitted changes. */
export async function readUnsavedBrainPaths(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['status', '--porcelain', '-z', '--untracked-files=all', '--', BRAIN_ROOT],
      { cwd: repoPath }
    )
    return stdout
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => toBrainRelative(entry.slice(3)))
      .sort()
  } catch {
    return []
  }
}

export async function readBrainHistory(repoPath: string, limit = 50): Promise<BrainHistoryResult> {
  try {
    const { stdout } = await gitExecFileAsync(
      [
        'log',
        `--max-count=${limit}`,
        `--format=${RECORD}%H${FIELD}%h${FIELD}%s${FIELD}%an${FIELD}%at`,
        '--name-only',
        '--',
        BRAIN_ROOT
      ],
      { cwd: repoPath }
    )
    return {
      saves: parseBrainLog(stdout),
      unavailable: false,
      unsavedPaths: await readUnsavedBrainPaths(repoPath)
    }
  } catch {
    // No git, or a repo with no commits yet. Saying so beats an empty list that
    // reads like the history was lost.
    return { saves: [], unavailable: true, unsavedPaths: [] }
  }
}

export async function saveBrain(repoPath: string, message: string): Promise<BrainSaveResult> {
  const subject = message.trim()
  if (!subject) {
    return { ok: false, savedPaths: [], error: 'Give this save a name' }
  }
  const savedPaths = await readUnsavedBrainPaths(repoPath)
  if (savedPaths.length === 0) {
    return { ok: false, savedPaths: [], error: 'Nothing has changed since the last save' }
  }
  try {
    // Pathspec-scoped throughout: stage and commit `.buildex/` and nothing else,
    // however dirty the rest of the working tree is.
    await gitExecFileAsync(['add', '--', BRAIN_ROOT], { cwd: repoPath })
    await gitExecFileAsync(['commit', '-m', subject, '--', BRAIN_ROOT], { cwd: repoPath })
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
export function brainDocumentPath(repoPath: string, documentId: string): string {
  return path.join(repoPath, BRAIN_ROOT, ...documentId.split('/'))
}
