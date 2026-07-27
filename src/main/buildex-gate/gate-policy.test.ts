import { describe, expect, it } from 'vitest'
import type { GatePreset } from '../../shared/buildex-gate-types'
import { decide, parseRule } from './gate-policy'
import { DEFAULT_GATE_PRESET, parseGatePreset } from './gate-preset'

function call(
  name: string,
  input: Record<string, unknown> = {}
): { name: string; input: Record<string, unknown> } {
  return { name, input }
}

describe('parseRule', () => {
  it('reads tool-level and argument-prefix rules', () => {
    expect(parseRule('Bash')).toEqual({ tool: 'Bash' })
    expect(parseRule('Bash(rm -rf:*)')).toEqual({ tool: 'Bash', argPrefix: 'rm -rf' })
    expect(parseRule('Bash(git push*)')).toEqual({ tool: 'Bash', argPrefix: 'git push' })
  })
})

describe('decide', () => {
  it('lets the agent get on with ordinary work', () => {
    expect(decide(DEFAULT_GATE_PRESET, call('Read'))).toBe('allow')
    expect(decide(DEFAULT_GATE_PRESET, call('Edit'))).toBe('allow')
    expect(decide(DEFAULT_GATE_PRESET, call('Bash', { command: 'npm test' }))).toBe('allow')
  })

  it('stops the destructive commands even though Bash is allowed', () => {
    // The point of the whole design: a narrow ask carves a gate out of a broad
    // allow, so autonomy stays wide without letting `rm -rf` through.
    expect(decide(DEFAULT_GATE_PRESET, call('Bash', { command: 'rm -rf build' }))).toBe('ask')
    expect(
      decide(DEFAULT_GATE_PRESET, call('Bash', { command: 'git push --force origin main' }))
    ).toBe('ask')
    expect(decide(DEFAULT_GATE_PRESET, call('Bash', { command: 'git reset --hard HEAD~3' }))).toBe(
      'ask'
    )
  })

  it('lets a narrower allow carve an exception out of a broad ask', () => {
    const preset: GatePreset = {
      allow: ['Bash(rm -rf node_modules:*)'],
      ask: ['Bash(rm -rf:*)'],
      deny: [],
      default: 'allow'
    }

    expect(decide(preset, call('Bash', { command: 'rm -rf node_modules' }))).toBe('allow')
    expect(decide(preset, call('Bash', { command: 'rm -rf src' }))).toBe('ask')
  })

  it('treats deny as absolute, however specific the allow', () => {
    const preset: GatePreset = {
      allow: ['Bash(curl https://internal:*)'],
      ask: [],
      deny: ['Bash(curl:*)'],
      default: 'allow'
    }

    expect(decide(preset, call('Bash', { command: 'curl https://internal/x' }))).toBe('deny')
  })

  it('falls back to the preset default for a tool no rule mentions', () => {
    expect(decide(DEFAULT_GATE_PRESET, call('SomeFutureTool'))).toBe('allow')
    expect(decide({ ...DEFAULT_GATE_PRESET, default: 'ask' }, call('SomeFutureTool'))).toBe('ask')
  })
})

describe('parseGatePreset', () => {
  it('fills the lists a partial preset leaves out', () => {
    const preset = parseGatePreset('{"ask":["Bash(docker:*)"]}')

    expect(preset?.ask).toEqual(['Bash(docker:*)'])
    expect(preset?.allow).toEqual(DEFAULT_GATE_PRESET.allow)
    expect(preset?.default).toBe('allow')
  })

  it('rejects a file that is not an object', () => {
    expect(parseGatePreset('not json')).toBeNull()
    expect(parseGatePreset('["allow"]')).toBeNull()
  })

  it('ignores a nonsense default rather than adopting it', () => {
    expect(parseGatePreset('{"default":"whatever"}')?.default).toBe('allow')
  })
})
