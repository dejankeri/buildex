import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRAIN_SECTIONS, scaffoldCompanyBrain } from './brain-scaffold'
import { isBrainInitialized } from './company-brain-scan'
import { embeddedLocation } from './brain-location'

let repo = ''

function location() {
  return embeddedLocation(repo)
}

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
    const result = scaffoldCompanyBrain(location())

    expect(result.created).toContain('strategy/')
    expect(result.created).toContain('decisions/log.md')
    expect(read('strategy/overview.md')).toContain('# Strategy')
  })

  it('creates every declared section', () => {
    scaffoldCompanyBrain(location())

    for (const section of BRAIN_SECTIONS) {
      expect(existsSync(path.join(repo, '.buildex', section.folder))).toBe(true)
    }
  })

  it('writes nothing the second time', () => {
    scaffoldCompanyBrain(location())

    expect(scaffoldCompanyBrain(location()).created).toEqual([])
  })

  it('never touches a section the company has already written in', () => {
    mkdirSync(path.join(repo, '.buildex', 'strategy'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'strategy', 'ours.md'), '# Ours\n', 'utf8')

    scaffoldCompanyBrain(location())

    // The seed must not appear beside their file, and theirs must survive.
    expect(existsSync(path.join(repo, '.buildex', 'strategy', 'overview.md'))).toBe(false)
    expect(read('strategy/ours.md')).toBe('# Ours\n')
  })

  it('leaves an edited seed alone', () => {
    scaffoldCompanyBrain(location())
    writeFileSync(path.join(repo, '.buildex', 'strategy', 'overview.md'), '# Rewritten\n', 'utf8')

    scaffoldCompanyBrain(location())

    expect(read('strategy/overview.md')).toBe('# Rewritten\n')
  })

  it('creates only the sections that were chosen', () => {
    scaffoldCompanyBrain(location(), { folders: ['strategy', 'decisions'] })

    expect(existsSync(path.join(repo, '.buildex', 'strategy'))).toBe(true)
    expect(existsSync(path.join(repo, '.buildex', 'decisions'))).toBe(true)
    expect(existsSync(path.join(repo, '.buildex', 'finance'))).toBe(false)
  })

  it("answers the seed's opening question with what the operator typed", () => {
    scaffoldCompanyBrain(location(), {
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
    scaffoldCompanyBrain(location(), { folders: ['strategy'], summary: '   ' })

    expect(read('strategy/overview.md')).toContain('One paragraph a stranger would understand')
  })

  it('puts the summary nowhere but the document that asked for it', () => {
    scaffoldCompanyBrain(location(), {
      folders: ['strategy', 'decisions'],
      summary: 'A coaching studio.'
    })

    expect(read('decisions/log.md')).not.toContain('A coaching studio.')
  })
})

describe('isBrainInitialized', () => {
  it('is false for a repo BuildEx has never touched', () => {
    expect(isBrainInitialized(location())).toBe(false)
  })

  it('is true once the operator has set sections up', () => {
    scaffoldCompanyBrain(location(), { folders: ['strategy'] })

    expect(isBrainInitialized(location())).toBe(true)
  })

  it('stays false when the only thing there is a pack the Store installed', () => {
    // Why: installing an app writes skills and a receipt into `.buildex/`. If
    // that counted as a brain, the operator would never be offered setup and
    // would be left with a brain that is nothing but somebody else's skills.
    mkdirSync(path.join(repo, '.buildex', 'skills', 'slack-search'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'packs.json'), '{"packs":{}}', 'utf8')

    expect(isBrainInitialized(location())).toBe(false)
  })

  it('stays false for a repo that has only a gate preset', () => {
    // The agent's permission policy is policy, not company knowledge — the
    // same mistake `.buildex/gate-applied.json` already caused, where its
    // presence alone meant setup was never offered again.
    mkdirSync(path.join(repo, '.buildex'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'gate-preset.json'), '{"deny":[]}', 'utf8')

    expect(isBrainInitialized(location())).toBe(false)
  })
})

describe('an external brain', () => {
  it('scaffolds into the brain repo, not the code repo', () => {
    const brain = mkdtempSync(path.join(tmpdir(), 'buildex-external-'))
    try {
      const external = { root: brain, gitRoot: brain, pathspec: '.', mode: 'external' as const }

      scaffoldCompanyBrain(external, { folders: ['strategy'] })

      expect(existsSync(path.join(brain, 'strategy', 'overview.md'))).toBe(true)
      // The code repo is untouched: no `.buildex/` appears beside the code.
      expect(existsSync(path.join(repo, '.buildex'))).toBe(false)
      expect(isBrainInitialized(external)).toBe(true)
    } finally {
      rmSync(brain, { recursive: true, force: true })
    }
  })
})
