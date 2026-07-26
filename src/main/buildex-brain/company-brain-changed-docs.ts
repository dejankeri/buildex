import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Which brain documents differ from the committed tree. Git is the company's
// record, so "changed" means "not yet saved into the company's history".

// Why: porcelain v1 is stable across every Git the app supports (2.25+), and -z
// avoids quoting/escaping rules for paths with spaces or non-ASCII characters.
const STATUS_ARGS = ['status', '--porcelain', '-z', '--untracked-files=all']

/** Repo-relative POSIX paths of markdown files with uncommitted changes. */
export async function listChangedDocumentIds(repoPath: string): Promise<string[]> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('git', STATUS_ARGS, {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    }))
  } catch {
    // Not a git repo, or git unavailable. The map still renders; nothing is
    // marked changed. A brain view is more useful than an error here.
    return []
  }

  const changed = new Set<string>()
  // -z output is NUL-separated `XY <path>` records. Renames emit a second NUL
  // record holding the origin path, which we skip via the pending flag.
  const records = stdout.split('\0')
  let skipNextAsRenameSource = false

  for (const record of records) {
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
    if (filePath.toLowerCase().endsWith('.md')) {
      changed.add(filePath)
    }
  }

  return [...changed].sort()
}
