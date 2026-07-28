import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_GATE_PRESET, withPluginRules } from './gate-preset'
import { syncGateSettings } from './gate-settings'

// An installed app's own gated verbs. Until now the shipped preset covered
// destroying work and rewriting history, and nothing covered an app's ability to
// message a customer or move money — a pack's policy was never read by anything.

const repos: string[] = []

function repo(): string {
  const created = mkdtempSync(path.join(tmpdir(), 'buildex-gate-'))
  repos.push(created)
  return created
}

function permissions(repoPath: string): Record<string, string[]> {
  return JSON.parse(readFileSync(path.join(repoPath, '.claude', 'settings.json'), 'utf8'))
    .permissions
}

afterEach(() => {
  for (const created of repos.splice(0)) {
    rmSync(created, { recursive: true, force: true })
  }
})

describe('withPluginRules', () => {
  it('adds an installed app’s gated verbs to the company preset', () => {
    const preset = withPluginRules(DEFAULT_GATE_PRESET, {
      ask: ['mcp__plugin_protocol-crm_protocol__schedule']
    })

    expect(preset.ask).toContain('mcp__plugin_protocol-crm_protocol__schedule')
    // The shipped rules are still there — a plugin adds to the gate, never
    // replaces it.
    expect(preset.ask).toContain('Bash(rm -rf:*)')
    expect(preset.allow).toEqual(DEFAULT_GATE_PRESET.allow)
  })

  it('does not list a rule twice when two plugins gate the same tool', () => {
    const preset = withPluginRules(DEFAULT_GATE_PRESET, {
      ask: ['mcp__a__send', 'mcp__a__send']
    })

    expect(preset.ask.filter((rule) => rule === 'mcp__a__send')).toHaveLength(1)
  })

  it('lets deny win over ask for the same rule', () => {
    // Why: the two lists disagreeing about one tool has exactly one safe answer.
    const preset = withPluginRules(DEFAULT_GATE_PRESET, {
      ask: ['mcp__a__delete'],
      deny: ['mcp__a__delete']
    })

    expect(preset.deny).toContain('mcp__a__delete')
    expect(preset.ask).not.toContain('mcp__a__delete')
  })

  it('leaves the preset alone when nothing installed contributes a rule', () => {
    expect(withPluginRules(DEFAULT_GATE_PRESET, {})).toEqual(DEFAULT_GATE_PRESET)
  })
})

describe('syncGateSettings with plugin rules', () => {
  it('writes an installed app’s gated verbs into the file the agent enforces', () => {
    const repoPath = repo()

    const result = syncGateSettings(repoPath, {
      ask: ['mcp__plugin_protocol-crm_protocol__manage_automations']
    })

    expect(result.preset.ask).toContain('mcp__plugin_protocol-crm_protocol__manage_automations')
    expect(permissions(repoPath).ask).toContain(
      'mcp__plugin_protocol-crm_protocol__manage_automations'
    )
  })

  it('retires a rule once its plugin is no longer installed', () => {
    // The receipt records the combined lists, so the next sync takes back
    // exactly what the previous one added and nothing the operator wrote.
    const repoPath = repo()
    syncGateSettings(repoPath, { ask: ['mcp__gone__send'] })
    expect(permissions(repoPath).ask).toContain('mcp__gone__send')

    syncGateSettings(repoPath, {})

    expect(permissions(repoPath).ask).not.toContain('mcp__gone__send')
    // The shipped gate survives the uninstall.
    expect(permissions(repoPath).ask).toContain('Bash(rm -rf:*)')
  })

  it('keeps a rule the operator added by hand', () => {
    const repoPath = repo()
    syncGateSettings(repoPath, { ask: ['mcp__app__send'] })
    const settingsPath = path.join(repoPath, '.claude', 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    settings.permissions.ask.push('Bash(terraform apply:*)')
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))

    syncGateSettings(repoPath, {})

    expect(permissions(repoPath).ask).toContain('Bash(terraform apply:*)')
    expect(permissions(repoPath).ask).not.toContain('mcp__app__send')
  })
})
