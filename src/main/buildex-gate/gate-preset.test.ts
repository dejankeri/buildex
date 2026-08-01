import { describe, expect, it } from 'vitest'
import { DEFAULT_GATE_PRESET, parseGatePreset } from './gate-preset'

// A company's override is a hand-editable file, so every shape it can be wrong
// in has to fall back to the shipped preset rather than to no gates at all.

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
