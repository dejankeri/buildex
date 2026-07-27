import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRAIN_SECTIONS, scaffoldCompanyBrain } from './brain-scaffold'

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
})
