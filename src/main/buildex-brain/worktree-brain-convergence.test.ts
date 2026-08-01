import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveBrainLocation } from './brain-location'
import { commitBrain } from './brain-history'
import { listBrainDocumentPaths } from './company-brain-scan'

// Every case here shells out to real `git`, repeatedly. Vitest's 5s default is a
// budget for pure functions, and under full-suite load these are the files that
// turn a loaded box into a red suite — the noise that hides a real regression.
vi.setConfig({ testTimeout: 60_000 })

// The defect this covers: `.buildex/` is branch content, so N parallel agent
// worktrees each saw the snapshot their branch was cut from and saved onto that
// branch — the brain fragmented exactly when the operator parallelised. Against
// a real repo, because the claim is about which branch a commit lands on.

let dir = ''
let repo = ''
let bindingsFile = ''
let one = ''
let two = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function branchOf(checkout: string): string {
  return git(checkout, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
}

function headOf(checkout: string): string {
  return git(checkout, 'rev-parse', 'HEAD').trim()
}

function locationOf(checkout: string) {
  const resolution = resolveBrainLocation(checkout, { bindingsFile })
  if (resolution.status !== 'ready') {
    throw new Error(`expected a ready brain, got ${resolution.status}`)
  }
  return resolution.location
}

beforeEach(() => {
  // Realpath because `git worktree add` records one, and on macOS the temp dir
  // is reached through a symlink — the resolver would answer /private/var here.
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'buildex-convergence-')))
  repo = path.join(dir, 'acme')
  bindingsFile = path.join(dir, 'brains.json')
  mkdirSync(path.join(repo, '.buildex', 'decisions'), { recursive: true })
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  git(repo, 'init', '--quiet')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(path.join(repo, '.buildex', 'decisions', 'pricing.md'), '# Pricing\n', 'utf8')
  writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 1\n', 'utf8')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'First')
  one = path.join(dir, 'acme-one')
  two = path.join(dir, 'acme-two')
  git(repo, 'worktree', 'add', '--quiet', '-b', 'feature-one', one)
  git(repo, 'worktree', 'add', '--quiet', '-b', 'feature-two', two)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('two worktrees of one company repo', () => {
  it('read the same brain', () => {
    expect(locationOf(one)).toEqual(locationOf(two))
    expect(locationOf(one).gitRoot).toBe(repo)
    expect(listBrainDocumentPaths(locationOf(one))).toEqual(['decisions/pricing.md'])
  })

  it('see what the other one wrote, without either branch moving', () => {
    const written = path.join(locationOf(one).root, 'decisions', 'hiring.md')
    mkdirSync(path.dirname(written), { recursive: true })
    writeFileSync(written, '# Hiring\n', 'utf8')

    expect(listBrainDocumentPaths(locationOf(two))).toEqual([
      'decisions/hiring.md',
      'decisions/pricing.md'
    ])
  })
})

describe('a save from a worktree', () => {
  it("lands on the primary checkout's branch, not the feature branch", async () => {
    const featureHead = headOf(one)
    writeFileSync(path.join(locationOf(one).root, 'decisions', 'pricing.md'), '# Pricing v2\n')

    const saved = await commitBrain(locationOf(one), 'Raised the floor')

    expect(saved.ok).toBe(true)
    expect(saved.savedPaths).toEqual(['decisions/pricing.md'])
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('Raised the floor')
    // The feature branch is exactly where it was: nothing of the company's
    // thinking is stranded on a branch that may never merge.
    expect(headOf(one)).toBe(featureHead)
    expect(branchOf(one)).toBe('feature-one')
    expect(branchOf(repo)).not.toBe('feature-one')
  })

  it('sweeps up no in-progress code, in either checkout', async () => {
    // The pathspec-scoping guarantee, asserted from the shape that makes it
    // matter most: the commit now lands in a checkout nobody is looking at.
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const a = 2 // half-written\n', 'utf8')
    writeFileSync(path.join(repo, 'src', 'staged.ts'), 'export const b = 3\n', 'utf8')
    git(repo, 'add', '--', path.join('src', 'staged.ts'))
    writeFileSync(path.join(one, 'src', 'app.ts'), 'export const a = 99\n', 'utf8')
    writeFileSync(path.join(locationOf(one).root, 'decisions', 'pricing.md'), '# Pricing v2\n')

    expect((await commitBrain(locationOf(one), 'Raised the floor')).ok).toBe(true)

    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual([
      path.posix.join('.buildex', 'decisions', 'pricing.md')
    ])
    // Still uncommitted, and the staged file still staged: a partial commit
    // leaves the rest of the operator's index exactly as they left it.
    expect(git(repo, 'status', '--porcelain', '--', 'src').split('\n').filter(Boolean)).toEqual([
      ' M src/app.ts',
      'A  src/staged.ts'
    ])
    expect(readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toContain('half-written')
    expect(readFileSync(path.join(one, 'src', 'app.ts'), 'utf8')).toContain('99')
  })
})

describe('a folder workspace that is no checkout', () => {
  it('keeps its own brain and saves nothing to git', async () => {
    const folder = path.join(dir, 'notes')
    mkdirSync(path.join(folder, '.buildex', 'decisions'), { recursive: true })
    writeFileSync(path.join(folder, '.buildex', 'decisions', 'a.md'), '# A\n', 'utf8')

    const location = locationOf(folder)

    expect(location.gitRoot).toBe(folder)
    expect(existsSync(location.root)).toBe(true)
    // No git here at all: the save reports it rather than throwing, and the
    // brain stays readable either way.
    expect((await commitBrain(location, 'First')).ok).toBe(false)
    expect(listBrainDocumentPaths(location)).toEqual(['decisions/a.md'])
  })
})
