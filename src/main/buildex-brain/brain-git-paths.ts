import { gitExecFileAsync } from '../git/runner'
import type { BrainLocation } from '../../shared/buildex-brain-types'

// Git talks in repo-relative paths; the brain is addressed by ids relative to
// its own root. This is the one place that translation lives, and the one place
// `git status` is parsed — two parsers of the same command disagreed on renames
// for as long as there were two.

// Embedded mode's pathspec is a prefix to strip; external's `.` already yields
// brain-relative paths, and stripping there would eat the first path segment.
export function toBrainRelative(location: BrainLocation, repoRelative: string): string {
  if (location.pathspec === '.') {
    return repoRelative
  }
  const prefix = `${location.pathspec}/`
  return repoRelative.startsWith(prefix) ? repoRelative.slice(prefix.length) : repoRelative
}

// Why: porcelain v1 is stable across every Git the app supports (2.25+), and -z
// avoids the quoting `core.quotePath` applies to paths with spaces or non-ASCII
// characters. Every option here long predates 2.25.
const STATUS_ARGS = ['status', '--porcelain', '-z', '--untracked-files=all']

const MAX_BUFFER_BYTES = 16 * 1024 * 1024

/**
 * `XY <path>` records, NUL-separated.
 *
 * A rename or a copy emits a **second** record holding the origin path, and that
 * record carries no status field — so parsing it like the first takes three
 * characters off the front of a real path and reports a file that does not
 * exist. Skipping it is the whole reason this parser is the one that survived.
 */
export function parseChangedBrainPaths(location: BrainLocation, stdout: string): string[] {
  const changed = new Set<string>()
  let skipNextAsRenameSource = false
  for (const record of stdout.split('\0')) {
    if (!record) {
      continue
    }
    if (skipNextAsRenameSource) {
      skipNextAsRenameSource = false
      continue
    }
    const status = record.slice(0, 2)
    const filePath = record.slice(3)
    if (status.startsWith('R') || status.startsWith('C')) {
      skipNextAsRenameSource = true
    }
    if (!filePath) {
      continue
    }
    changed.add(toBrainRelative(location, filePath))
  }
  return [...changed].sort()
}

/** Brain-relative paths with uncommitted changes. */
export async function readChangedBrainPaths(location: BrainLocation): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync([...STATUS_ARGS, '--', location.pathspec], {
      cwd: location.gitRoot,
      maxBuffer: MAX_BUFFER_BYTES
    })
    return parseChangedBrainPaths(location, stdout)
  } catch {
    // Not a git repo, or git unavailable. A brain view is more useful than an
    // error here: nothing is marked changed and everything still renders.
    return []
  }
}
