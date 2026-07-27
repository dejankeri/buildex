import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// File-level plumbing shared by install and refresh. A pack's skills are real
// files copied out of the catalog into the company repo, so the operator can
// read, edit and diff them like anything else in the repo.
//
// Everything here is content-addressed: we record the hash of every file we
// write, so a later refresh can tell "unchanged since we wrote it" (safe to
// replace with a newer version) from "the operator edited this" (never
// clobber — invariant 8, never lose an operator's work).

export type PlannedFile = {
  /** Repo-relative POSIX path. */
  relativePath: string
  absoluteSource: string
}

export function hashContent(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

export function hashFile(absolutePath: string): string | null {
  try {
    return hashContent(readFileSync(absolutePath, 'utf8'))
  } catch {
    return null
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/**
 * Every file under a pack's `skills/<skill>/` directory, sorted, addressed by
 * the repo-relative path it will occupy. Sorted so a plan is deterministic and
 * two runs over the same catalog write the same thing in the same order.
 */
export function planSkillFiles(packSourceDir: string, skills: string[]): PlannedFile[] {
  const planned: PlannedFile[] = []
  for (const skill of [...skills].sort()) {
    const sourceDir = path.join(packSourceDir, 'skills', skill)
    for (const relative of walkFiles(sourceDir)) {
      planned.push({
        // Why: .buildex/ is the one place BuildEx owns, so everything it writes
        // can be excluded, inspected or deleted as a unit. The agent runtime
        // reaches these files through a link in .claude/skills (see skill-link).
        relativePath: `.buildex/skills/${skill}/${toPosix(relative)}`,
        absoluteSource: path.join(sourceDir, relative)
      })
    }
  }
  return planned.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

/** Relative paths of every file below `root`, depth-first and sorted. */
function walkFiles(root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root).sort()
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) {
      continue
    }
    const absolute = path.join(root, entry)
    let isDirectory = false
    try {
      isDirectory = statSync(absolute).isDirectory()
    } catch {
      continue
    }
    if (isDirectory) {
      files.push(...walkFiles(absolute).map((nested) => path.join(entry, nested)))
    } else {
      files.push(entry)
    }
  }
  return files
}

export type WriteOutcome = 'written' | 'unchanged' | 'kept-operator-edit'

export type WriteDecision = {
  outcome: WriteOutcome
  hash: string
}

/**
 * Copy one planned file into the repo.
 *
 * `recordedHash` is what we wrote there last time, or null if we have never
 * written it. The rule: only replace a file whose current contents are exactly
 * what we last put there. Anything else is the operator's, and stays.
 */
export function writePlannedFile(
  repoPath: string,
  planned: PlannedFile,
  recordedHash: string | null
): WriteDecision {
  const source = readFileSync(planned.absoluteSource, 'utf8')
  const sourceHash = hashContent(source)
  const destination = path.join(repoPath, ...planned.relativePath.split('/'))

  if (existsSync(destination)) {
    const currentHash = hashFile(destination)
    if (currentHash === sourceHash) {
      return { outcome: 'unchanged', hash: sourceHash }
    }
    if (currentHash !== recordedHash) {
      // The file on disk is neither the new version nor the one we wrote, so the
      // operator changed it. Leave it alone and report it.
      return { outcome: 'kept-operator-edit', hash: currentHash ?? '' }
    }
  }

  mkdirSync(path.dirname(destination), { recursive: true })
  writeFileSync(destination, source, 'utf8')
  return { outcome: 'written', hash: sourceHash }
}
