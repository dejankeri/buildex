import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateBrainToExternal } from './brain-migrate'
import { readBrainPointer } from './brain-location'

let dir = ''
let repo = ''
let brain = ''
let bindingsFile = ''

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'buildex-migrate-'))
  repo = path.join(dir, 'api')
  brain = path.join(dir, 'acme-brain')
  bindingsFile = path.join(dir, 'brains.json')

  mkdirSync(path.join(repo, '.buildex', 'decisions'), { recursive: true })
  writeFileSync(path.join(repo, '.buildex', 'decisions', 'pricing.md'), '# Pricing\n', 'utf8')
  git(dir, 'init', '--quiet', repo)
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'the brain so far')

  execFileSync('git', ['init', '--quiet', brain])
  git(brain, 'config', 'user.email', 'test@example.com')
  git(brain, 'config', 'user.name', 'Test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('migrateBrainToExternal', () => {
  it('moves the documents, leaves a pointer, and keeps the code repo history', async () => {
    const result = await migrateBrainToExternal(
      {
        repoPath: repo,
        brainPath: brain,
        remote: 'git@github.com:acme/brain.git',
        writePointer: true,
        bindingsFile
      },
      1_700_000_000_000
    )

    expect(result.ok).toBe(true)
    expect(result.movedPaths).toEqual(['decisions/pricing.md'])
    expect(readFileSync(path.join(brain, 'decisions', 'pricing.md'), 'utf8')).toBe('# Pricing\n')

    // HEAD carries the pointer and nothing else of the brain's.
    expect(existsSync(path.join(repo, '.buildex', 'decisions'))).toBe(false)
    expect(readBrainPointer(repo)).toBe('git@github.com:acme/brain.git')

    // And the old brain is still reachable in the code repo's history.
    const log = execFileSync('git', ['log', '--all', '--name-only', '--format='], {
      cwd: repo,
      encoding: 'utf8'
    })
    expect(log).toContain('.buildex/decisions/pricing.md')
  })

  it('takes a backup before it removes anything', async () => {
    const result = await migrateBrainToExternal(
      { repoPath: repo, brainPath: brain, writePointer: false, bindingsFile },
      1_700_000_000_000
    )

    expect(result.backupPath).toBeTruthy()
    expect(existsSync(path.join(result.backupPath ?? '', 'decisions', 'pricing.md'))).toBe(true)
    rmSync(result.backupPath ?? '', { recursive: true, force: true })
  })

  it('writes no pointer when the operator declined one, but still removes the brain from HEAD', async () => {
    await migrateBrainToExternal(
      { repoPath: repo, brainPath: brain, writePointer: false, bindingsFile },
      1_700_000_000_000
    )

    expect(readBrainPointer(repo)).toBeNull()

    // Not merely staged: gone from the tip commit itself.
    const tracked = execFileSync('git', ['ls-tree', '-r', 'HEAD', '--name-only'], {
      cwd: repo,
      encoding: 'utf8'
    })
    expect(tracked).not.toContain('.buildex/')

    // While still reachable from the past.
    const log = execFileSync('git', ['log', '--all', '--name-only', '--format='], {
      cwd: repo,
      encoding: 'utf8'
    })
    expect(log).toContain('.buildex/decisions/pricing.md')
  })

  it('leaves the source brain untouched when the target repo fails to record the commit', async () => {
    // The target already has this exact content committed, so commitBrain sees
    // nothing to save and returns ok:false without throwing.
    mkdirSync(path.join(brain, 'decisions'), { recursive: true })
    writeFileSync(path.join(brain, 'decisions', 'pricing.md'), '# Pricing\n', 'utf8')
    git(brain, 'add', '.')
    git(brain, 'commit', '--quiet', '-m', 'already have this')

    const result = await migrateBrainToExternal(
      { repoPath: repo, brainPath: brain, writePointer: false, bindingsFile },
      1_700_000_000_000
    )

    expect(result.ok).toBe(false)
    expect(result.backupPath).toBeTruthy()
    expect(existsSync(path.join(repo, '.buildex', 'decisions', 'pricing.md'))).toBe(true)
    rmSync(result.backupPath ?? '', { recursive: true, force: true })
  })

  it('moves a document git never saw without losing the ones it did', async () => {
    writeFileSync(path.join(repo, '.buildex', 'decisions', 'draft.md'), '# Half a thought\n')

    const result = await migrateBrainToExternal(
      { repoPath: repo, brainPath: brain, writePointer: false, bindingsFile },
      1_700_000_000_000
    )

    expect(result.ok).toBe(true)
    expect(existsSync(path.join(brain, 'decisions', 'draft.md'))).toBe(true)
    // The tracked one still has to leave HEAD, however the untracked one fared.
    const tracked = execFileSync('git', ['ls-tree', '-r', 'HEAD', '--name-only'], {
      cwd: repo,
      encoding: 'utf8'
    })
    expect(tracked).not.toContain('.buildex/')
    rmSync(result.backupPath ?? '', { recursive: true, force: true })
  })

  it('says where the files went when the repo cannot be pointed at them', async () => {
    // A bindings file that cannot be written: its parent is a regular file.
    writeFileSync(path.join(dir, 'blocked'), 'not a directory\n', 'utf8')

    const result = await migrateBrainToExternal(
      {
        repoPath: repo,
        brainPath: brain,
        writePointer: false,
        bindingsFile: path.join(dir, 'blocked', 'brains.json')
      },
      1_700_000_000_000
    )

    // The source is already gone by this point, so the one thing the operator
    // must not be left guessing at is where their brain is now.
    expect(result.ok).toBe(false)
    expect(result.error).toContain(brain)
    expect(result.backupPath).toBeTruthy()
    expect(existsSync(path.join(brain, 'decisions', 'pricing.md'))).toBe(true)
    rmSync(result.backupPath ?? '', { recursive: true, force: true })
  })

  it('leaves the agent holding links that resolve into the new brain root', async () => {
    mkdirSync(path.join(repo, '.buildex', 'skills', 'slack-search'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'skills', 'slack-search', 'SKILL.md'), '# S\n')
    mkdirSync(path.join(repo, '.buildex', 'skills', 'how-we-price'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'skills', 'how-we-price', 'SKILL.md'), '# P\n')
    // Embedded links are relative, so the move leaves every one of them dangling.
    mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true })
    symlinkSync(
      path.join('..', '..', '.buildex', 'skills', 'slack-search'),
      path.join(repo, '.claude', 'skills', 'slack-search'),
      'dir'
    )

    const result = await migrateBrainToExternal(
      { repoPath: repo, brainPath: brain, writePointer: false, bindingsFile },
      1_700_000_000_000
    )

    expect(result.ok).toBe(true)
    // Both: the one that was linked before, and the company skill that never was.
    for (const name of ['how-we-price', 'slack-search']) {
      const link = path.join(repo, '.claude', 'skills', name)
      expect(realpathSync(link)).toBe(realpathSync(path.join(brain, 'skills', name)))
    }
    rmSync(result.backupPath ?? '', { recursive: true, force: true })
  })

  it('moves what the brain owns and leaves what it does not', async () => {
    // The company's agent permission policy and its own pack catalog: read from
    // the code repo in both modes, so taking them changes what the agent may do.
    writeFileSync(path.join(repo, '.buildex', 'gate-preset.json'), '{"deny":["Bash"]}\n', 'utf8')
    mkdirSync(path.join(repo, '.buildex', 'catalog', 'slack'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'catalog', 'slack', 'pack.json'), '{}\n', 'utf8')
    mkdirSync(path.join(repo, '.buildex', 'skills', 'slack-search'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'skills', 'slack-search', 'SKILL.md'), '# S\n')

    const result = await migrateBrainToExternal(
      { repoPath: repo, brainPath: brain, writePointer: false, bindingsFile },
      1_700_000_000_000
    )

    expect(result.ok).toBe(true)
    expect(existsSync(path.join(brain, 'skills', 'slack-search', 'SKILL.md'))).toBe(true)
    expect(existsSync(path.join(brain, 'gate-preset.json'))).toBe(false)
    expect(existsSync(path.join(brain, 'catalog'))).toBe(false)

    // Still where the code repo reads them from, and still what git holds.
    expect(readFileSync(path.join(repo, '.buildex', 'gate-preset.json'), 'utf8')).toBe(
      '{"deny":["Bash"]}\n'
    )
    expect(existsSync(path.join(repo, '.buildex', 'catalog', 'slack', 'pack.json'))).toBe(true)
    expect(existsSync(path.join(repo, '.buildex', 'skills'))).toBe(false)
    expect(existsSync(path.join(repo, '.buildex', 'decisions'))).toBe(false)
    rmSync(result.backupPath ?? '', { recursive: true, force: true })
  })
})
