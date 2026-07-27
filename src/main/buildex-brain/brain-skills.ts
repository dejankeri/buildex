import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrainSkill, BrainSkillCreateResult } from '../../shared/buildex-brain-types'
import { readPackState } from '../buildex-packs/pack-state'
import { linkSkillIntoAgentDir } from '../buildex-packs/skill-link'
import { toDocumentFileName } from './brain-document-create'

// The company's skills — what its agent knows how to do here.
//
// Two kinds live side by side in `.buildex/skills/`: skills a pack installed,
// and skills the company wrote. Telling them apart matters, because one is
// replaced by an app update and the other is somebody's work.
//
// Sharing is git. `.buildex/` is tracked, so a teammate who pulls gets the
// skills, and the link into `.claude/skills/` is rebuilt for them on open —
// which is why the link itself is never committed.

const SKILLS_DIR = path.join('.buildex', 'skills')

const SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function firstHeading(body: string): string | null {
  for (const line of body.split('\n').slice(0, 40)) {
    const match = line.match(/^#\s+(.+)$/)
    if (match) {
      return match[1].trim()
    }
  }
  return null
}

/** The `description:` line of the frontmatter, which is what the agent matches on. */
function frontmatterDescription(body: string): string | null {
  if (!body.startsWith('---')) {
    return null
  }
  const end = body.indexOf('\n---', 3)
  if (end === -1) {
    return null
  }
  for (const line of body.slice(0, end).split('\n')) {
    const match = line.match(/^description:\s*(.+)$/i)
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, '')
    }
  }
  return null
}

export function listBrainSkills(repoPath: string): BrainSkill[] {
  const root = path.join(repoPath, SKILLS_DIR)
  let entries: string[]
  try {
    entries = readdirSync(root).sort()
  } catch {
    return []
  }

  // Every skill the receipt attributes to a pack; everything else the company wrote.
  const fromPacks = new Set<string>()
  for (const record of Object.values(readPackState(repoPath).packs)) {
    for (const relativePath of Object.keys(record.files)) {
      const match = relativePath.match(/^\.buildex\/skills\/([^/]+)\//)
      if (match) {
        fromPacks.add(match[1])
      }
    }
  }

  const skills: BrainSkill[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) {
      continue
    }
    const manifestPath = path.join(root, entry, 'SKILL.md')
    try {
      if (!statSync(path.join(root, entry)).isDirectory() || !existsSync(manifestPath)) {
        continue
      }
    } catch {
      continue
    }
    let body = ''
    try {
      body = readFileSync(manifestPath, 'utf8')
    } catch {
      continue
    }
    skills.push({
      name: entry,
      title: firstHeading(body) ?? entry,
      description: frontmatterDescription(body) ?? '',
      source: fromPacks.has(entry) ? 'pack' : 'company',
      // The agent only sees a skill through this link.
      linked: existsSync(path.join(repoPath, '.claude', 'skills', entry))
    })
  }
  return skills
}

/** A skill the company writes itself. Scaffolded so it is usable immediately. */
export function createBrainSkill(repoPath: string, title: string): BrainSkillCreateResult {
  const fileName = toDocumentFileName(title)
  const name = fileName?.replace(/\.md$/, '') ?? ''
  // Why: this becomes a directory name and the agent's handle for the skill.
  if (!name || !SKILL_ID_RE.test(name)) {
    return { ok: false, error: 'Use letters, numbers and hyphens' }
  }
  const directory = path.join(repoPath, SKILLS_DIR, name)
  const manifestPath = path.join(directory, 'SKILL.md')
  if (existsSync(manifestPath)) {
    return { ok: false, error: `Already exists: ${name}` }
  }
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      manifestPath,
      `---
name: ${name}
description: Use when ${title.trim().toLowerCase()}.
---

# ${title.trim()}

Say what the agent should do, in the order it should do it. Be specific enough
that two people would carry it out the same way.

## Steps

1.
2.

## Check before finishing

-
`,
      'utf8'
    )
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  // Without the link the skill exists but the agent never sees it.
  linkSkillIntoAgentDir(repoPath, name)
  return { ok: true, name, absolutePath: manifestPath }
}
