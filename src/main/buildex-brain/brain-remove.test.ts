import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const home = mkdtempSync(path.join(tmpdir(), 'buildex-home-'))

// Why: the backup lands in the operator's home directory, which a test must
// never write to. Everything else about `node:os` stays real.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } }
})

const { BACKUP_ROOT, backupStamp, disconnectBrain, planBrainRemoval, removeBrain } =
  await import('./brain-remove')
const { pruneDanglingSkillLinks } = await import('../buildex-packs/skill-link')
const { gitExecFileAsync } = await import('../git/runner')
const { bindRepoToBrain, readBrainBindings } = await import('./brain-bindings')
const { embeddedLocation, externalLocation, readBrainPointer, writeBrainPointer } =
  await import('./brain-location')

let repo = ''

const NOW = Date.UTC(2026, 6, 27, 14, 25, 30)

function write(relativePath: string, contents: string): void {
  const absolute = path.join(repo, ...relativePath.split('/'))
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

async function git(...args: string[]): Promise<void> {
  await gitExecFileAsync(args, { cwd: repo })
}

async function initRepo(): Promise<void> {
  await git('init', '--initial-branch=main')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-remove-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(BACKUP_ROOT, { recursive: true, force: true })
})

describe('backupStamp', () => {
  it('sorts chronologically and stays legible in a file dialog', () => {
    expect(backupStamp(NOW)).toBe('2026-07-27-14-25-30')
  })
})

describe('planBrainRemoval', () => {
  it('says a copy is needed when there is no git to fall back on', async () => {
    write('.buildex/strategy/overview.md', '# Strategy\n')

    const plan = await planBrainRemoval(embeddedLocation(repo))

    expect(plan.documentCount).toBe(1)
    expect(plan.canCommit).toBe(false)
    expect(plan.willBackUp).toBe(true)
  })

  it('says the removal can be committed once the brain is in history', async () => {
    await initRepo()
    write('.buildex/strategy/overview.md', '# Strategy\n')
    await git('add', '-A')
    await git('commit', '-m', 'First save')

    const plan = await planBrainRemoval(embeddedLocation(repo))

    expect(plan.canCommit).toBe(true)
    expect(plan.willBackUp).toBe(false)
  })
})

describe('removeBrain', () => {
  it('refuses when there is no brain to remove', async () => {
    const result = await removeBrain(repo, embeddedLocation(repo), NOW)

    expect(result.ok).toBe(false)
  })

  it('backs the brain up before removing it when git cannot get it back', async () => {
    write('.buildex/strategy/overview.md', '# Strategy\n')

    const result = await removeBrain(repo, embeddedLocation(repo), NOW)

    expect(result.ok).toBe(true)
    expect(result.backupPath).toBeDefined()
    expect(readFileSync(path.join(result.backupPath!, 'strategy', 'overview.md'), 'utf8')).toBe(
      '# Strategy\n'
    )
    expect(existsSync(path.join(repo, '.buildex'))).toBe(false)
  })

  it('records the removal as a save when git holds the brain', async () => {
    await initRepo()
    write('.buildex/strategy/overview.md', '# Strategy\n')
    await git('add', '-A')
    await git('commit', '-m', 'First save')

    const result = await removeBrain(repo, embeddedLocation(repo), NOW)

    expect(result.committed).toBe(true)
    expect(result.backupPath).toBeUndefined()
    expect(existsSync(path.join(repo, '.buildex'))).toBe(false)
    // Why: recoverable is the whole promise — the removal has to be in history,
    // not merely absent from the working tree.
    const { stdout } = await gitExecFileAsync(['log', '--format=%s'], { cwd: repo })
    expect(stdout).toContain('Removed the company brain')
  })

  it('does both when some of the brain was never saved', async () => {
    await initRepo()
    write('.buildex/strategy/overview.md', '# Strategy\n')
    await git('add', '-A')
    await git('commit', '-m', 'First save')
    write('.buildex/strategy/draft.md', '# Half a thought\n')

    const result = await removeBrain(repo, embeddedLocation(repo), NOW)

    expect(result.committed).toBe(true)
    expect(readFileSync(path.join(result.backupPath!, 'strategy', 'draft.md'), 'utf8')).toBe(
      '# Half a thought\n'
    )
  })

  it('refuses to delete an external brain, however it is called', async () => {
    const brain = mkdtempSync(path.join(tmpdir(), 'buildex-external-brain-'))
    try {
      mkdirSync(path.join(brain, 'decisions'), { recursive: true })
      writeFileSync(path.join(brain, 'decisions', 'pricing.md'), '# Pricing\n', 'utf8')

      const result = await removeBrain(repo, externalLocation(brain), NOW)

      // Why: the IPC dispatch is a routing decision, not the only lock on this
      // door — removeBrain must refuse on its own even if a future caller
      // forgets to check the mode first.
      expect(result.ok).toBe(false)
      expect(result.committed).toBe(false)
      expect(existsSync(path.join(brain, 'decisions', 'pricing.md'))).toBe(true)
    } finally {
      rmSync(brain, { recursive: true, force: true })
    }
  })

  it('leaves everything outside the brain exactly as it was', async () => {
    await initRepo()
    write('.buildex/strategy/overview.md', '# Strategy\n')
    write('src/index.ts', 'export const x = 1\n')
    await git('add', '-A')
    await git('commit', '-m', 'First save')
    writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const x = 2\n', 'utf8')

    await removeBrain(repo, embeddedLocation(repo), NOW)

    // Why: the operator asked to remove their brain, not to commit whatever they
    // happened to be editing at the time.
    expect(readFileSync(path.join(repo, 'src', 'index.ts'), 'utf8')).toBe('export const x = 2\n')
    const { stdout } = await gitExecFileAsync(['status', '--porcelain'], { cwd: repo })
    expect(stdout).toContain('src/index.ts')
  })
})

describe('pruneDanglingSkillLinks', () => {
  it('drops a link whose skill has gone', async () => {
    write('.buildex/skills/slack-search/SKILL.md', '# Slack search\n')
    const { symlinkSync } = await import('node:fs')
    mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true })
    symlinkSync(
      path.join('..', '..', '.buildex', 'skills', 'slack-search'),
      path.join(repo, '.claude', 'skills', 'slack-search'),
      'dir'
    )

    expect(pruneDanglingSkillLinks(repo)).toEqual([])

    rmSync(path.join(repo, '.buildex'), { recursive: true, force: true })

    // Why: left behind, the agent reads a set of broken skills. Checked by
    // listing the directory, not with existsSync — a dangling link is invisible
    // to existsSync whether it was removed or not.
    expect(pruneDanglingSkillLinks(repo)).toEqual(['slack-search'])
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(path.join(repo, '.claude', 'skills'))).toEqual([])
  })

  it('never removes a real directory somebody put there by hand', () => {
    write('.claude/skills/ours/SKILL.md', '# Ours\n')

    expect(pruneDanglingSkillLinks(repo)).toEqual([])
    expect(existsSync(path.join(repo, '.claude', 'skills', 'ours', 'SKILL.md'))).toBe(true)
  })
})

describe('disconnectBrain', () => {
  it('unbinds this repo and leaves a shared brain completely alone', () => {
    const brain = mkdtempSync(path.join(tmpdir(), 'buildex-shared-brain-'))
    const bindingsFile = path.join(brain, 'bindings.json')
    try {
      mkdirSync(path.join(brain, 'decisions'), { recursive: true })
      writeFileSync(path.join(brain, 'decisions', 'pricing.md'), '# Pricing\n', 'utf8')
      bindRepoToBrain(repo, brain, bindingsFile)
      writeBrainPointer(repo, 'git@github.com:acme/brain.git')

      const result = disconnectBrain(repo, { bindingsFile })

      expect(result.ok).toBe(true)
      // The point of the whole split: other repos share this brain, and one of
      // them pressing Remove must not take it from the rest.
      expect(existsSync(path.join(brain, 'decisions', 'pricing.md'))).toBe(true)
      expect(readBrainBindings(bindingsFile).brainByRepo[repo]).toBeUndefined()
      expect(readBrainPointer(repo)).toBeNull()
    } finally {
      rmSync(brain, { recursive: true, force: true })
    }
  })

  it('takes the agent off a healthy brain it no longer belongs to', async () => {
    const brain = mkdtempSync(path.join(tmpdir(), 'buildex-shared-brain-'))
    const bindingsFile = path.join(brain, 'bindings.json')
    try {
      mkdirSync(path.join(brain, '.git'), { recursive: true })
      mkdirSync(path.join(brain, 'skills', 'slack-search'), { recursive: true })
      writeFileSync(path.join(brain, 'skills', 'slack-search', 'SKILL.md'), '# Slack\n', 'utf8')
      bindRepoToBrain(repo, brain, bindingsFile)
      const { relinkBrainSkills } = await import('../buildex-packs/skill-link')
      const { externalLocation: external } = await import('./brain-location')
      relinkBrainSkills(repo, external(brain))
      write('.claude/skills/hand-written/SKILL.md', '# Mine\n')

      disconnectBrain(repo, { bindingsFile })

      // Why: pruning cannot do this — the brain is healthy, so every link still
      // resolves and the agent would keep loading a disconnected company's skills.
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(path.join(repo, '.claude', 'skills'))).toEqual(['hand-written'])
      expect(existsSync(path.join(brain, 'skills', 'slack-search', 'SKILL.md'))).toBe(true)
    } finally {
      rmSync(brain, { recursive: true, force: true })
    }
  })
})
