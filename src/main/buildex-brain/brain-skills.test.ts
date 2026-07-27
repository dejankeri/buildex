import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBrainSkill, listBrainSkills } from './brain-skills'

let repo = ''

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
  it('separates what a pack installed from what the company wrote', () => {
    write('.buildex/skills/slack-search/SKILL.md', '# Slack search\n')
    write('.buildex/skills/onboard-client/SKILL.md', '# Onboard a client\n')
    write(
      '.buildex/packs.json',
      JSON.stringify({
        packs: { slack: { files: { '.buildex/skills/slack-search/SKILL.md': 'abc' } } }
      })
    )

    const skills = listBrainSkills(repo)

    expect(skills.find((s) => s.name === 'slack-search')?.source).toBe('pack')
    expect(skills.find((s) => s.name === 'onboard-client')?.source).toBe('company')
  })

  it('reads the title and the description the agent matches on', () => {
    write(
      '.buildex/skills/weekly-review/SKILL.md',
      '---\nname: weekly-review\ndescription: Use when closing out the week.\n---\n\n# Weekly review\n'
    )

    const skill = listBrainSkills(repo)[0]

    expect(skill.title).toBe('Weekly review')
    expect(skill.description).toBe('Use when closing out the week.')
  })

  it('flags a skill the agent cannot see', () => {
    write('.buildex/skills/orphaned/SKILL.md', '# Orphaned\n')

    // No .claude/skills link — the skill exists but is invisible to the agent.
    expect(listBrainSkills(repo)[0].linked).toBe(false)
  })

  it('ignores a directory with no SKILL.md', () => {
    mkdirSync(path.join(repo, '.buildex/skills/not-a-skill'), { recursive: true })

    expect(listBrainSkills(repo)).toEqual([])
  })

  it('is empty rather than failing when there are no skills', () => {
    expect(listBrainSkills(repo)).toEqual([])
  })
})

describe('createBrainSkill', () => {
  it('scaffolds a usable skill and links it for the agent', () => {
    const result = createBrainSkill(repo, 'Onboard a new client')

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
    expect(createBrainSkill(repo, '///').ok).toBe(false)
  })

  it('never overwrites an existing skill', () => {
    createBrainSkill(repo, 'Weekly review')

    expect(createBrainSkill(repo, 'Weekly review').error).toContain('Already exists')
  })
})
