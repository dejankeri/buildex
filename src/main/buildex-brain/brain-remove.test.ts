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

const { BACKUP_ROOT, backupStamp, planBrainRemoval, pruneDanglingSkillLinks, removeBrain } =
  await import('./brain-remove')
const { gitExecFileAsync } = await import('../git/runner')

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

    const plan = await planBrainRemoval(repo)

    expect(plan.documentCount).toBe(1)
    expect(plan.canCommit).toBe(false)
    expect(plan.willBackUp).toBe(true)
  })

  it('says the removal can be committed once the brain is in history', async () => {
    await initRepo()
    write('.buildex/strategy/overview.md', '# Strategy\n')
    await git('add', '-A')
    await git('commit', '-m', 'First save')

    const plan = await planBrainRemoval(repo)

    expect(plan.canCommit).toBe(true)
    expect(plan.willBackUp).toBe(false)
  })
})

describe('removeBrain', () => {
  it('refuses when there is no brain to remove', async () => {
    const result = await removeBrain(repo, NOW)

    expect(result.ok).toBe(false)
  })

  it('backs the brain up before removing it when git cannot get it back', async () => {
    write('.buildex/strategy/overview.md', '# Strategy\n')

    const result = await removeBrain(repo, NOW)

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

    const result = await removeBrain(repo, NOW)

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

    const result = await removeBrain(repo, NOW)

    expect(result.committed).toBe(true)
    expect(readFileSync(path.join(result.backupPath!, 'strategy', 'draft.md'), 'utf8')).toBe(
      '# Half a thought\n'
    )
  })

  it('leaves everything outside the brain exactly as it was', async () => {
    await initRepo()
    write('.buildex/strategy/overview.md', '# Strategy\n')
    write('src/index.ts', 'export const x = 1\n')
    await git('add', '-A')
    await git('commit', '-m', 'First save')
    writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const x = 2\n', 'utf8')

    await removeBrain(repo, NOW)

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

    // Why: left behind, the agent reads a set of broken skills.
    expect(pruneDanglingSkillLinks(repo)).toEqual(['slack-search'])
    expect(existsSync(path.join(repo, '.claude', 'skills', 'slack-search'))).toBe(false)
  })

  it('never removes a real directory somebody put there by hand', () => {
    write('.claude/skills/ours/SKILL.md', '# Ours\n')

    expect(pruneDanglingSkillLinks(repo)).toEqual([])
    expect(existsSync(path.join(repo, '.claude', 'skills', 'ours', 'SKILL.md'))).toBe(true)
  })
})
