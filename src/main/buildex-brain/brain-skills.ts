import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  BrainLocation,
  BrainSkill,
  BrainSkillCreateResult
} from '../../shared/buildex-brain-types'
import { linkSkillIntoAgentDir, skillsRoot } from './skill-link'
import { toDocumentFileName } from './brain-document-create'

// The company's skills — what its agent knows how to do here.
//
// All of them are the company's own. The Store installs plugins through the
// agent's plugin cache now, so nothing it does lands in the brain's `skills/`
// and there is no longer a second kind to tell apart.
//
// Sharing is git. The brain is tracked, so a teammate who pulls gets the
// skills, and the link into `.claude/skills/` is rebuilt for them on open —
// which is why the link itself is never committed.

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

export function listBrainSkills(repoPath: string, location: BrainLocation): BrainSkill[] {
  const root = skillsRoot(location)
  let entries: string[]
  try {
    entries = readdirSync(root).sort()
  } catch {
    return []
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
      source: 'company',
      // The agent only sees a skill through this link.
      linked: existsSync(path.join(repoPath, '.claude', 'skills', entry))
    })
  }
  return skills
}

/** A skill the company writes itself. Scaffolded so it is usable immediately. */
export function createBrainSkill(
  repoPath: string,
  location: BrainLocation,
  title: string
): BrainSkillCreateResult {
  const fileName = toDocumentFileName(title)
  const name = fileName?.replace(/\.md$/, '') ?? ''
  // Why: this becomes a directory name and the agent's handle for the skill.
  if (!name || !SKILL_ID_RE.test(name)) {
    return { ok: false, error: 'Use letters, numbers and hyphens' }
  }
  const directory = path.join(skillsRoot(location), name)
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
  linkSkillIntoAgentDir(repoPath, location, name)
  return { ok: true, name, absolutePath: manifestPath }
}
