import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { embeddedLocation } from './brain-location'
import { CAPTURE_SKILL_NAME, seedCaptureSkill } from './capture-skill-seed'
import { listBrainSkills } from './brain-skills'
import { scaffoldCompanyBrain } from './brain-scaffold'

let repo = ''

function manifestPath(): string {
  return path.join(repo, '.buildex', 'skills', CAPTURE_SKILL_NAME, 'SKILL.md')
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-capture-skill-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('the seeded capture skill', () => {
  it('is written when a company sets its brain up', () => {
    const result = scaffoldCompanyBrain(embeddedLocation(repo), { folders: ['decisions'] })

    expect(result.created).toContain(`skills/${CAPTURE_SKILL_NAME}/SKILL.md`)
    expect(readFileSync(manifestPath(), 'utf8')).toContain(`name: ${CAPTURE_SKILL_NAME}`)
  })

  it('arrives even when the operator chose no decisions section', () => {
    // Capture is how anything reaches any section; it is not the decisions
    // section's private convention.
    scaffoldCompanyBrain(embeddedLocation(repo), { folders: ['finance'] })

    expect(readFileSync(manifestPath(), 'utf8')).toContain('# Record a decision')
  })

  it('tells the agent where to write and to date the entry', () => {
    seedCaptureSkill(embeddedLocation(repo))
    const body = readFileSync(manifestPath(), 'utf8')

    expect(body).toContain('decisions/log.md')
    expect(body).toContain('rules/operating.md')
    expect(body).toContain('YYYY-MM-DD')
    // The description is what the agent matches on, so both phrasings must be in it.
    expect(body).toContain('record this decision')
    expect(body).toContain('record this learning')
  })

  it('is discoverable as one of the company’s own skills', () => {
    seedCaptureSkill(embeddedLocation(repo))

    const skills = listBrainSkills(repo, embeddedLocation(repo))

    expect(skills.map((skill) => skill.name)).toEqual([CAPTURE_SKILL_NAME])
    expect(skills[0].description).toContain('record this decision')
  })

  it('never overwrites a skill the company has since edited', () => {
    seedCaptureSkill(embeddedLocation(repo))
    writeFileSync(manifestPath(), '# Ours\n', 'utf8')

    expect(seedCaptureSkill(embeddedLocation(repo))).toBeNull()
    expect(readFileSync(manifestPath(), 'utf8')).toBe('# Ours\n')
  })

  it('leaves a directory the operator already put there alone', () => {
    mkdirSync(path.join(repo, '.buildex', 'skills', CAPTURE_SKILL_NAME), { recursive: true })

    expect(seedCaptureSkill(embeddedLocation(repo))).toBeNull()
  })
})
