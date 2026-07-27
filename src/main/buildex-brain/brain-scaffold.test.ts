import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRAIN_SECTIONS, scaffoldCompanyBrain } from './brain-scaffold'
import { isBrainInitialized } from './company-brain-scan'

let repo = ''

function read(relativePath: string): string {
  return readFileSync(path.join(repo, '.buildex', relativePath), 'utf8')
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-scaffold-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('scaffoldCompanyBrain', () => {
  it('gives a new company somewhere to start', () => {
    const result = scaffoldCompanyBrain(repo)

    expect(result.created).toContain('strategy/')
    expect(result.created).toContain('decisions/log.md')
    expect(read('strategy/overview.md')).toContain('# Strategy')
  })

  it('creates every declared section', () => {
    scaffoldCompanyBrain(repo)

    for (const section of BRAIN_SECTIONS) {
      expect(existsSync(path.join(repo, '.buildex', section.folder))).toBe(true)
    }
  })

  it('writes nothing the second time', () => {
    scaffoldCompanyBrain(repo)

    expect(scaffoldCompanyBrain(repo).created).toEqual([])
  })

  it('never touches a section the company has already written in', () => {
    mkdirSync(path.join(repo, '.buildex', 'strategy'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'strategy', 'ours.md'), '# Ours\n', 'utf8')

    scaffoldCompanyBrain(repo)

    // The seed must not appear beside their file, and theirs must survive.
    expect(existsSync(path.join(repo, '.buildex', 'strategy', 'overview.md'))).toBe(false)
    expect(read('strategy/ours.md')).toBe('# Ours\n')
  })

  it('leaves an edited seed alone', () => {
    scaffoldCompanyBrain(repo)
    writeFileSync(path.join(repo, '.buildex', 'strategy', 'overview.md'), '# Rewritten\n', 'utf8')

    scaffoldCompanyBrain(repo)

    expect(read('strategy/overview.md')).toBe('# Rewritten\n')
  })

  it('creates only the sections that were chosen', () => {
    scaffoldCompanyBrain(repo, { folders: ['strategy', 'decisions'] })

    expect(existsSync(path.join(repo, '.buildex', 'strategy'))).toBe(true)
    expect(existsSync(path.join(repo, '.buildex', 'decisions'))).toBe(true)
    expect(existsSync(path.join(repo, '.buildex', 'finance'))).toBe(false)
  })

  it("answers the seed's opening question with what the operator typed", () => {
    scaffoldCompanyBrain(repo, {
      folders: ['strategy'],
      summary: 'We help fitness coaches run their business.'
    })

    const overview = read('strategy/overview.md')
    expect(overview).toContain('We help fitness coaches run their business.')
    // Why: substituted, not appended — the document must not carry both the
    // question and its answer.
    expect(overview).not.toContain('One paragraph a stranger would understand')
  })

  it('leaves the question in place when nothing was typed', () => {
    scaffoldCompanyBrain(repo, { folders: ['strategy'], summary: '   ' })

    expect(read('strategy/overview.md')).toContain('One paragraph a stranger would understand')
  })

  it('puts the summary nowhere but the document that asked for it', () => {
    scaffoldCompanyBrain(repo, {
      folders: ['strategy', 'decisions'],
      summary: 'A coaching studio.'
    })

    expect(read('decisions/log.md')).not.toContain('A coaching studio.')
  })
})

describe('isBrainInitialized', () => {
  it('is false for a repo BuildEx has never touched', () => {
    expect(isBrainInitialized(repo)).toBe(false)
  })

  it('is true once the operator has set sections up', () => {
    scaffoldCompanyBrain(repo, { folders: ['strategy'] })

    expect(isBrainInitialized(repo)).toBe(true)
  })

  it('stays false when the only thing there is a pack the Store installed', () => {
    // Why: installing an app writes skills and a receipt into `.buildex/`. If
    // that counted as a brain, the operator would never be offered setup and
    // would be left with a brain that is nothing but somebody else's skills.
    mkdirSync(path.join(repo, '.buildex', 'skills', 'slack-search'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'packs.json'), '{"packs":{}}', 'utf8')

    expect(isBrainInitialized(repo)).toBe(false)
  })
})
