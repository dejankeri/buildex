import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { embeddedLocation } from './brain-location'
import { createBrainSkill, listBrainSkills } from './brain-skills'

let repo = ''

function location() {
  return embeddedLocation(repo)
}

function write(relativePath: string, contents: string): void {
  const absolute = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-skills-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('listBrainSkills', () => {
  // Why: the Store installs through the agent's plugin cache now, so nothing it
  // does lands here. A legacy receipt from the pack era must not make the
  // company's own skill look like somebody else's.
  it('treats every skill in the brain as the company own, legacy receipt or not', () => {
    write('.buildex/skills/slack-search/SKILL.md', '# Slack search\n')
    write('.buildex/skills/onboard-client/SKILL.md', '# Onboard a client\n')
    write(
      '.buildex/packs.json',
      JSON.stringify({
        packs: { slack: { files: { '.buildex/skills/slack-search/SKILL.md': 'abc' } } }
      })
    )

    const skills = listBrainSkills(repo, location())

    expect(skills.map((s) => s.source)).toEqual(['company', 'company'])
  })

  it('reads the title and the description the agent matches on', () => {
    write(
      '.buildex/skills/weekly-review/SKILL.md',
      '---\nname: weekly-review\ndescription: Use when closing out the week.\n---\n\n# Weekly review\n'
    )

    const skill = listBrainSkills(repo, location())[0]

    expect(skill.title).toBe('Weekly review')
    expect(skill.description).toBe('Use when closing out the week.')
  })

  it('flags a skill the agent cannot see', () => {
    write('.buildex/skills/orphaned/SKILL.md', '# Orphaned\n')

    // No .claude/skills link — the skill exists but is invisible to the agent.
    expect(listBrainSkills(repo, location())[0].linked).toBe(false)
  })

  it('ignores a directory with no SKILL.md', () => {
    mkdirSync(path.join(repo, '.buildex/skills/not-a-skill'), { recursive: true })

    expect(listBrainSkills(repo, location())).toEqual([])
  })

  it('is empty rather than failing when there are no skills', () => {
    expect(listBrainSkills(repo, location())).toEqual([])
  })
})

describe('createBrainSkill', () => {
  it('scaffolds a usable skill and links it for the agent', () => {
    const result = createBrainSkill(repo, location(), 'Onboard a new client')

    expect(result).toMatchObject({ ok: true, name: 'onboard-a-new-client' })
    const body = readFileSync(
      path.join(repo, '.buildex/skills/onboard-a-new-client/SKILL.md'),
      'utf8'
    )
    expect(body).toContain('name: onboard-a-new-client')
    expect(body).toContain('description: Use when onboard a new client.')
    expect(existsSync(path.join(repo, '.claude/skills/onboard-a-new-client'))).toBe(true)
  })

  it('refuses a name that could not be a directory', () => {
    expect(createBrainSkill(repo, location(), '///').ok).toBe(false)
  })

  it('never overwrites an existing skill', () => {
    createBrainSkill(repo, location(), 'Weekly review')

    expect(createBrainSkill(repo, location(), 'Weekly review').error).toContain('Already exists')
  })

  it('links a skill from an external brain with an absolute target', () => {
    const brain = mkdtempSync(path.join(tmpdir(), 'buildex-skills-external-'))
    try {
      const external = { root: brain, gitRoot: brain, pathspec: '.', mode: 'external' as const }

      const result = createBrainSkill(repo, external, 'Answer support email')

      expect(result.ok).toBe(true)
      expect(existsSync(path.join(brain, 'skills', 'answer-support-email', 'SKILL.md'))).toBe(true)
      // The agent only ever sees a skill through the link in its own repo.
      expect(existsSync(path.join(repo, '.claude', 'skills', 'answer-support-email'))).toBe(true)
      // And the skill lists as this company's, from the brain it actually lives in.
      expect(listBrainSkills(repo, external).map((skill) => skill.name)).toContain(
        'answer-support-email'
      )
    } finally {
      rmSync(brain, { recursive: true, force: true })
    }
  })
})
