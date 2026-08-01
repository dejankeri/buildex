import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { externalLocation } from './brain-location'
import { readChangedBrainPaths } from './brain-git-paths'
import { commitBrain, readBrainHistory } from './brain-history'

let brain = ''

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: brain })
}

beforeEach(() => {
  brain = mkdtempSync(path.join(tmpdir(), 'buildex-history-'))
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
})

afterEach(() => {
  rmSync(brain, { recursive: true, force: true })
})

describe('an external brain repo', () => {
  it('reports its own files as unsaved, brain-relative', async () => {
    mkdirSync(path.join(brain, 'decisions'), { recursive: true })
    writeFileSync(path.join(brain, 'decisions', 'pricing.md'), '# Pricing\n', 'utf8')

    expect(await readChangedBrainPaths(externalLocation(brain))).toEqual(['decisions/pricing.md'])
  })

  it('commits and then reads its own history back', async () => {
    writeFileSync(path.join(brain, 'note.md'), '# Note\n', 'utf8')

    const saved = await commitBrain(externalLocation(brain), 'First decision')

    expect(saved.ok).toBe(true)
    expect(saved.savedPaths).toEqual(['note.md'])

    const history = await readBrainHistory(externalLocation(brain))
    expect(history.unavailable).toBe(false)
    expect(history.saves[0]?.subject).toBe('First decision')
    expect(history.saves[0]?.changedPaths).toEqual(['note.md'])
  })

  it('refuses a save with nothing in it', async () => {
    writeFileSync(path.join(brain, 'note.md'), '# Note\n', 'utf8')
    await commitBrain(externalLocation(brain), 'First')

    const second = await commitBrain(externalLocation(brain), 'Second')

    expect(second.ok).toBe(false)
    expect(second.error).toBe('Nothing has changed since the last save')
  })
})
