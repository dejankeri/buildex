import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_GATE_PRESET } from './gate-preset'
import { syncGateSettings } from './gate-settings'

let repo = ''

function write(relativePath: string, contents: string): void {
  const absolute = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

function readSettings(): { permissions: { allow: string[]; ask: string[]; deny: string[] } } {
  return JSON.parse(readFileSync(path.join(repo, '.claude/settings.json'), 'utf8'))
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-gate-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('syncGateSettings', () => {
  it('writes the shipped gate into the file the agent enforces', () => {
    const result = syncGateSettings(repo)

    expect(result.source).toBe('bundle')
    expect(result.settingsChanged).toBe(true)
    expect(readSettings().permissions.ask).toEqual(DEFAULT_GATE_PRESET.ask)
    expect(readSettings().permissions.allow).toContain('Bash')
  })

  it('writes nothing the second time', () => {
    syncGateSettings(repo)

    expect(syncGateSettings(repo).settingsChanged).toBe(false)
  })

  it("keeps the operator's own rules and reports them", () => {
    write(
      '.claude/settings.json',
      JSON.stringify({ permissions: { ask: ['Bash(terraform apply:*)'] } })
    )

    const result = syncGateSettings(repo)

    expect(readSettings().permissions.ask).toContain('Bash(terraform apply:*)')
    expect(result.preservedRules).toEqual(['ask: Bash(terraform apply:*)'])
  })

  it('leaves unrelated settings untouched', () => {
    write('.claude/settings.json', JSON.stringify({ model: 'opus', permissions: { allow: [] } }))

    syncGateSettings(repo)

    expect(JSON.parse(readFileSync(path.join(repo, '.claude/settings.json'), 'utf8')).model).toBe(
      'opus'
    )
  })

  it("adopts the company's own preset when it has one", () => {
    write('.buildex/gate-preset.json', JSON.stringify({ ask: ['Bash(docker compose down:*)'] }))

    const result = syncGateSettings(repo)

    expect(result.source).toBe('repo')
    expect(readSettings().permissions.ask).toEqual(['Bash(docker compose down:*)'])
  })

  it('retires a rule the company removed from its preset, but nothing else', () => {
    write('.buildex/gate-preset.json', JSON.stringify({ ask: ['Bash(docker:*)'] }))
    syncGateSettings(repo)
    const withOperatorRule = readSettings()
    withOperatorRule.permissions.ask.push('Bash(kubectl delete:*)')
    write('.claude/settings.json', JSON.stringify(withOperatorRule))

    write('.buildex/gate-preset.json', JSON.stringify({ ask: [] }))
    syncGateSettings(repo)

    expect(readSettings().permissions.ask).toEqual(['Bash(kubectl delete:*)'])
  })

  it('falls back to the shipped preset when the company file is broken', () => {
    write('.buildex/gate-preset.json', '{ not json')

    const result = syncGateSettings(repo)

    // A typo must never read as "no gates".
    expect(result.source).toBe('bundle')
    expect(readSettings().permissions.ask).toEqual(DEFAULT_GATE_PRESET.ask)
  })
})
