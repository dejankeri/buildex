import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('writes no pointer when the operator declined one', async () => {
    await migrateBrainToExternal(
      { repoPath: repo, brainPath: brain, writePointer: false, bindingsFile },
      1_700_000_000_000
    )

    expect(readBrainPointer(repo)).toBeNull()
  })
})
