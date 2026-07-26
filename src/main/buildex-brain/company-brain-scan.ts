import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// Filesystem walk for the company brain. Sorted at every level so two scans of
// an unchanged tree produce identical output — the determinism the trust
// surfaces depend on.

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.conflicts',
  '.sessions',
  '.agent',
  'node_modules',
  'dist',
  'out'
])

// Why: skill manifests are the agent's verbs, not company knowledge. A repo with
// a dozen packs installed has a dozen identical `SKILL.md` nodes, which drowns
// the actual brain. They belong in a Skills surface, not the map.
const SKILL_MANIFEST_RE = /(^|\/)skills\/.*\/SKILL\.md$/i

export function isSkillManifest(relativeId: string): boolean {
  return SKILL_MANIFEST_RE.test(relativeId)
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/** Repo-relative POSIX paths of every brain document, sorted. */
export function listBrainDocumentPaths(repoPath: string): string[] {
  const found: string[] = []

  const walk = (absoluteDir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(absoluteDir).sort()
    } catch {
      // Unreadable directory (permissions, race with a delete): skip rather than
      // fail the whole scan — a partial map beats no map.
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || IGNORED_DIRECTORIES.has(entry)) {
        continue
      }
      const absolute = path.join(absoluteDir, entry)
      let isDirectory: boolean
      try {
        isDirectory = statSync(absolute).isDirectory()
      } catch {
        continue
      }
      if (isDirectory) {
        walk(absolute)
        continue
      }
      if (!entry.toLowerCase().endsWith('.md')) {
        continue
      }
      const id = toPosix(path.relative(repoPath, absolute))
      if (!isSkillManifest(id)) {
        found.push(id)
      }
    }
  }

  walk(repoPath)
  return found.sort()
}

export function readDocumentText(repoPath: string, documentId: string): string {
  try {
    return readFileSync(path.join(repoPath, documentId), 'utf8')
  } catch {
    return ''
  }
}

export function countHeadings(text: string): number {
  return text.split('\n').filter((line) => /^#{1,6}\s+\S/.test(line)).length
}

export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}
