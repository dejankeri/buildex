import { gitExecFileAsync } from '../git/runner'
import type { NativeChatDiffLine } from '../../shared/native-chat-diff'
import type {
  BrainDiffStatus,
  BrainLocation,
  BrainSaveDiffFile,
  BrainSaveDiffResult
} from '../../shared/buildex-brain-types'
import { toBrainRelative } from './brain-history'

// What one save changed, read straight out of git.
//
// The point is reviewability: an operator who let agents write to the brain
// overnight needs to see what those runs added, not what the documents say now.
// The current document is the one thing a diff view must never show.
//
// Two reads of the same commit, paired by position. `--name-status -z` gives
// paths and rename detection with no quoting to undo; the patch gives the lines.
// Git emits both in the same order for the same pathspec, so index i of one is
// index i of the other — and when the counts disagree the paths still stand on
// their own, which is the case the pairing is allowed to lose.
//
// Pathspec-scoped like everything else here: a hand-made commit that touched
// code and the brain together shows only its brain half, because that is all
// this screen claims to be about.

function unreadable(): BrainSaveDiffResult {
  return { files: [], truncated: false, unavailable: true, linesUnavailable: false }
}

/** A commit hash and nothing else — never a revision expression, never an option. */
const HASH_RE = /^[0-9a-f]{7,40}$/i

// Bounds, not preferences: this renders inside a sidebar, and an operator
// scanning a night's work needs the shape of it, not every byte.
const MAX_FILES = 40
const MAX_LINES_PER_FILE = 300
const MAX_BUFFER_BYTES = 8 * 1024 * 1024

// Flags pinned deliberately, all of them long predating Git 2.25:
// `--format=` drops the commit header, `-M` detects renames even where
// `diff.renames` is configured off, and `--no-ext-diff`/`--no-textconv` keep an
// operator's global diff driver from replacing the patch with its own output.
//
// `--no-show-signature` for the same reason and a sharper one: an operator who
// signs commits and sets `log.showSignature` gets a verification line printed
// ahead of the diff, inside the `-z` stream, where it fuses onto the first
// status letter and silently mislabels the first file.
const SHOW_BASE = [
  'show',
  '--format=',
  '-M',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-show-signature'
]

function toStatus(letter: string): BrainDiffStatus {
  switch (letter[0]) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'changed'
  }
}

type StatusEntry = { path: string; previousPath?: string; status: BrainDiffStatus }

/** `A\0path\0` for most, `R100\0old\0new\0` for a rename or a copy. */
function parseNameStatus(location: BrainLocation, stdout: string): StatusEntry[] {
  const fields = stdout.split('\0').filter((field) => field.length > 0)
  const entries: StatusEntry[] = []
  for (let i = 0; i < fields.length; ) {
    const status = toStatus(fields[i])
    const takesTwoPaths = status === 'renamed' || status === 'copied'
    const first = fields[i + 1]
    if (first === undefined) {
      break
    }
    if (takesTwoPaths) {
      const second = fields[i + 2]
      if (second === undefined) {
        break
      }
      entries.push({
        status,
        path: toBrainRelative(location, second),
        previousPath: toBrainRelative(location, first)
      })
      i += 3
      continue
    }
    entries.push({ status, path: toBrainRelative(location, first) })
    i += 2
  }
  return entries
}

/** One `diff --git` block per file, in the order git emitted them. */
function splitPatchBlocks(patch: string): string[][] {
  const blocks: string[][] = []
  // Trailing newline trimmed first, or every last file gains a phantom blank line.
  for (const line of patch.replace(/\n+$/, '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      blocks.push([])
    }
    blocks.at(-1)?.push(line)
  }
  return blocks
}

/**
 * A block's hunks, classified for rendering.
 *
 * Everything before the first `@@` is git's own header — and `--- a/x` there
 * would otherwise read as a deleted line, which is exactly the mislabelling a
 * hand-rolled classifier gets wrong.
 */
function classifyPatchBlock(block: string[]): {
  lines: NativeChatDiffLine[]
  binary: boolean
  truncated: boolean
} {
  const binary = block.some(
    (line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch')
  )
  const start = block.findIndex((line) => line.startsWith('@@'))
  if (binary || start === -1) {
    return { lines: [], binary, truncated: false }
  }
  const body = block.slice(start)
  const truncated = body.length > MAX_LINES_PER_FILE
  const lines: NativeChatDiffLine[] = []
  for (const line of body.slice(0, MAX_LINES_PER_FILE)) {
    if (line.startsWith('@@') || line.startsWith('\\')) {
      lines.push({ kind: 'meta', text: line })
    } else if (line.startsWith('+')) {
      lines.push({ kind: 'add', text: line.slice(1) })
    } else if (line.startsWith('-')) {
      lines.push({ kind: 'del', text: line.slice(1) })
    } else {
      lines.push({ kind: 'context', text: line.slice(1) })
    }
  }
  return { lines, binary, truncated }
}

/**
 * The diff of one save, brain-relative.
 *
 * A merge commit reads as empty: git shows nothing for a merge that changed
 * nothing against its parents, and inventing a combined diff here would be a
 * different claim than the one the history made. The caller says "no changes"
 * rather than failing.
 */
export async function readBrainSaveDiff(
  location: BrainLocation,
  hash: string
): Promise<BrainSaveDiffResult> {
  if (!HASH_RE.test(hash)) {
    return unreadable()
  }
  const options = { cwd: location.gitRoot, maxBuffer: MAX_BUFFER_BYTES }
  let entries: StatusEntry[]
  let blocks: string[][]
  try {
    const status = await gitExecFileAsync(
      [...SHOW_BASE, '-z', '--name-status', hash, '--', location.pathspec],
      options
    )
    entries = parseNameStatus(location, status.stdout)
    const patch = await gitExecFileAsync(
      [...SHOW_BASE, '--patch', hash, '--', location.pathspec],
      options
    )
    blocks = splitPatchBlocks(patch.stdout)
  } catch {
    return unreadable()
  }

  const paired = blocks.length === entries.length
  const files: BrainSaveDiffFile[] = entries.slice(0, MAX_FILES).map((entry, index) => {
    const block = paired ? classifyPatchBlock(blocks[index]) : null
    return {
      path: entry.path,
      ...(entry.previousPath !== undefined ? { previousPath: entry.previousPath } : {}),
      status: entry.status,
      binary: block?.binary ?? false,
      lines: block?.lines ?? [],
      truncated: block?.truncated ?? false
    }
  })
  return {
    files,
    truncated: entries.length > MAX_FILES,
    unavailable: false,
    linesUnavailable: !paired
  }
}
