import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { BrainLocation } from '../../shared/buildex-brain-types'

// Filesystem walk for the company brain. Sorted at every level so two scans of
// an unchanged tree produce identical output — the determinism the trust
// surfaces depend on.
//
// The brain is `.buildex/`, not the whole repo. That folder is where the company
// keeps what it knows — decisions, rules, the skills it wrote — kept deliberately
// apart from the codebase so a project's own README and design docs do not drown
// the company's own thinking. One folder, versioned with the repo like anything
// else the team owns.

export const BRAIN_ROOT = '.buildex'

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.conflicts',
  '.sessions',
  '.agent',
  'node_modules',
  'dist',
  'out'
])

// Why: skills are the agent's verbs, not company knowledge — and a pack ships
// reference documents beside its SKILL.md, so excluding only the manifest let a
// dozen installed packs drown the map anyway. The whole tree is out.
const SKILLS_TREE_RE = /^skills\//i

// Left in the brain folder by an older BuildEx, which generated the agent's
// company context here before it moved to `.claude/`. Skipped so a repo that
// still carries one does not map BuildEx's own output as company knowledge in
// the window before the sync removes it.
const GENERATED_BRAIN_FILES = new Set(['company-context.md'])

export function isSkillManifest(relativeId: string): boolean {
  return SKILLS_TREE_RE.test(relativeId)
}

export function isGeneratedBrainFile(relativeId: string): boolean {
  return GENERATED_BRAIN_FILES.has(relativeId.toLowerCase())
}

// Things BuildEx puts in the brain folder on the operator's behalf rather than
// things the company wrote. Installing an app from the Store lands skills here,
// and that must not count as "this company has a brain" — otherwise an operator
// who installs Slack before writing anything never gets offered setup, and ends
// up with a brain that is nothing but somebody else's skills.
const MACHINE_BRAIN_ENTRIES = new Set([
  'skills',
  'packs.json',
  'brain.json',
  // Policy, not knowledge — and the same mistake `gate-applied.json` already
  // cost us: its presence alone made a repo read as having a brain, so setup
  // was never offered there.
  'gate-preset.json'
])

/**
 * True once this repo holds a company brain.
 *
 * Deliberately not `existsSync('.buildex')`: the folder alone proves only that
 * BuildEx has run here. What counts is whether anything in it is the company's.
 */
export function isBrainInitialized(location: BrainLocation): boolean {
  if (!existsSync(location.root)) {
    return false
  }
  try {
    return readdirSync(location.root).some(
      (entry) => !entry.startsWith('.') && !MACHINE_BRAIN_ENTRIES.has(entry)
    )
  } catch {
    // Unreadable is not the same as absent, and offering to set up a brain we
    // cannot see would overwrite one that is already there.
    return true
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/** Brain-relative POSIX paths of every brain document, sorted. */
export function listBrainDocumentPaths(location: BrainLocation): string[] {
  const found: string[] = []
  const brainRoot = location.root

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
      // Why: dot-entries are skipped inside the brain too — `.buildex` itself is
      // the root we start from, so nothing below it needs to be a dot-name, and
      // a stray one is machine state rather than company knowledge.
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
      // Why: ids stay relative to the brain root, not the repo, so a document
      // reads as `decisions/pricing.md` rather than `.buildex/decisions/…`. The
      // folder is plumbing; the operator should not have to see it.
      const id = toPosix(path.relative(brainRoot, absolute))
      if (!isSkillManifest(id) && !isGeneratedBrainFile(id)) {
        found.push(id)
      }
    }
  }

  walk(brainRoot)
  return found.sort()
}

export function readDocumentText(location: BrainLocation, documentId: string): string {
  try {
    return readFileSync(path.join(location.root, documentId), 'utf8')
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
