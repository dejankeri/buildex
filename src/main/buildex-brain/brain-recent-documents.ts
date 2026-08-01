import { gitExecFileAsync } from '../git/runner'
import type { BrainLocation } from '../../shared/buildex-brain-types'
import { toBrainRelative } from './brain-git-paths'

// Which brain documents changed most recently, read out of git.
//
// Link degree says what a company organises around; recency says what it has
// been doing. For an operator — or an agent — returning to a business after
// weeks, the second is the better first question. And unlike "uncommitted right
// now", it holds still for a whole session, because it is history rather than
// working-tree state.
//
// Everything below degrades to an empty list. A brain with no commits yet, a
// folder workspace that is no repo at all, an SSH host with no git on it: none
// of those is an error worth failing a scan over, and a brain without a history
// is still a brain.

/**
 * Commits read before giving up on filling the list. A bound, not a preference:
 * a brain saved daily for years must not turn one scan into a full history walk.
 */
const COMMIT_WINDOW = 200
const MAX_BUFFER_BYTES = 4 * 1024 * 1024

// The same pinned flags `brain-save-diff.ts` uses, for the same reasons, and
// every one of them long predates Git 2.25: `--format=` drops the commit header
// so only paths come back, `-M` keeps a rename from reading as an add plus a
// delete under `diff.renames=false`, `--no-ext-diff`/`--no-textconv` keep an
// operator's global diff driver out of it, and `--no-show-signature` stops a
// verification line from being printed into the stream we parse.
//
// `-z` additionally: `--name-only` octal-quotes any non-ASCII path by default
// (`core.quotePath`), which would make a brain written in French unmatchable
// against the ids the scan just produced.
const LOG_ARGS = [
  'log',
  `--max-count=${COMMIT_WINDOW}`,
  '--format=',
  '--name-only',
  '-z',
  '-M',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-show-signature'
]

/**
 * Brain-relative ids in the order git last touched them, newest first.
 *
 * Filtered against `knownIds`: a path git remembers but the brain no longer
 * holds — deleted, renamed away, moved out of the pathspec — is not somewhere to
 * send anybody.
 */
export async function listRecentlyChangedDocuments(
  location: BrainLocation,
  knownIds: ReadonlySet<string>,
  limit: number
): Promise<string[]> {
  let stdout: string
  try {
    ;({ stdout } = await gitExecFileAsync([...LOG_ARGS, '--', location.pathspec], {
      cwd: location.gitRoot,
      maxBuffer: MAX_BUFFER_BYTES
    }))
  } catch {
    return []
  }

  const recent: string[] = []
  const seen = new Set<string>()
  for (const field of stdout.split('\0')) {
    if (recent.length >= limit) {
      break
    }
    if (!field) {
      continue
    }
    const id = toBrainRelative(location, field)
    if (seen.has(id) || !knownIds.has(id)) {
      continue
    }
    seen.add(id)
    recent.push(id)
  }
  return recent
}
