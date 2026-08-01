import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkoutCommitBlockMessage, readCheckoutCommitBlock } from './checkout-commit-block'
import { commitBrain } from './brain-history'
import { embeddedLocation } from './brain-location'

// Every case here shells out to real `git`, repeatedly. Vitest's 5s default is a
// budget for pure functions, and under full-suite load these are the files that
// turn a loaded box into a red suite — the noise that hides a real regression.
vi.setConfig({ testTimeout: 60_000 })

let dir = ''
let repo = ''

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** Leaves `repo` on `main` with a conflicted merge of `other` underway. */
function conflictedMerge(): void {
  git(repo, 'checkout', '--quiet', '-b', 'other')
  writeFileSync(path.join(repo, 'src', 'app.ts'), 'theirs\n', 'utf8')
  git(repo, 'commit', '--quiet', '-am', 'Theirs')
  git(repo, 'checkout', '--quiet', '-')
  writeFileSync(path.join(repo, 'src', 'app.ts'), 'ours\n', 'utf8')
  git(repo, 'commit', '--quiet', '-am', 'Ours')
  try {
    git(repo, 'merge', 'other')
  } catch {
    // The conflict is the point.
  }
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'buildex-in-progress-')))
  repo = path.join(dir, 'acme')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  mkdirSync(path.join(repo, '.buildex', 'decisions'), { recursive: true })
  git(repo, 'init', '--quiet')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(path.join(repo, 'src', 'app.ts'), 'base\n', 'utf8')
  writeFileSync(path.join(repo, '.buildex', 'decisions', 'pricing.md'), '# Pricing\n', 'utf8')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'First')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readCheckoutCommitBlock', () => {
  it('says nothing is in progress in an ordinary checkout', async () => {
    expect(await readCheckoutCommitBlock(repo)).toBeNull()
  })

  it('says nothing for a folder that is no repo at all', async () => {
    const folder = path.join(dir, 'notes')
    mkdirSync(folder, { recursive: true })

    expect(await readCheckoutCommitBlock(folder)).toBeNull()
  })

  it('names a conflicted merge', async () => {
    conflictedMerge()

    expect(await readCheckoutCommitBlock(repo)).toBe('merge')
  })

  it('names a conflicted rebase', async () => {
    git(repo, 'checkout', '--quiet', '-b', 'other')
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'theirs\n', 'utf8')
    git(repo, 'commit', '--quiet', '-am', 'Theirs')
    git(repo, 'checkout', '--quiet', '-')
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'ours\n', 'utf8')
    git(repo, 'commit', '--quiet', '-am', 'Ours')
    try {
      git(repo, 'rebase', 'other')
    } catch {
      // The conflict is the point.
    }

    expect(await readCheckoutCommitBlock(repo)).toBe('rebase')
  })

  it('names a detached HEAD, which git would let the commit through on', async () => {
    git(repo, 'checkout', '--quiet', '--detach', 'HEAD')

    // The opposite failure to a conflicted merge: nothing refuses, the save
    // reports success, and the commit is unreachable the moment the operator
    // checks a branch out again.
    expect(await readCheckoutCommitBlock(repo)).toBe('detached-head')
  })

  it('names a bisect, which detaches HEAD once it picks a midpoint', async () => {
    const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    for (const n of ['second', 'third']) {
      writeFileSync(path.join(repo, 'src', 'app.ts'), `${n}\n`, 'utf8')
      git(repo, 'commit', '--quiet', '-am', n)
    }
    git(repo, 'bisect', 'start')
    git(repo, 'bisect', 'bad', 'HEAD')
    git(repo, 'bisect', 'good', first)

    expect(await readCheckoutCommitBlock(repo)).toBe('detached-head')
  })

  it('says nothing for a repo with no commits yet, where the branch is unborn', async () => {
    const fresh = path.join(dir, 'fresh')
    mkdirSync(fresh, { recursive: true })
    git(fresh, 'init', '--quiet')

    // `symbolic-ref HEAD` resolves to refs/heads/<name> before the first commit,
    // and committing there is exactly what a first save does.
    expect(await readCheckoutCommitBlock(fresh)).toBeNull()
  })

  it('reports the operation ahead of the detached HEAD a rebase also leaves', async () => {
    git(repo, 'checkout', '--quiet', '-b', 'other')
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'theirs\n', 'utf8')
    git(repo, 'commit', '--quiet', '-am', 'Theirs')
    git(repo, 'checkout', '--quiet', '-')
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'ours\n', 'utf8')
    git(repo, 'commit', '--quiet', '-am', 'Ours')
    try {
      git(repo, 'rebase', 'other')
    } catch {
      // The conflict is the point.
    }

    // Both are true mid-rebase; the rebase is the one the operator has to
    // resolve, and the branch comes back with it.
    expect(await readCheckoutCommitBlock(repo)).toBe('rebase')
  })

  it('reads the state of the checkout asked about, not the repo', async () => {
    const worktree = path.join(dir, 'acme-feature')
    git(repo, 'worktree', 'add', '--quiet', '-b', 'feature', worktree)
    conflictedMerge()

    // Each checkout has its own git dir, and the worktree is idle even though
    // the primary checkout is stuck.
    expect(await readCheckoutCommitBlock(worktree)).toBeNull()
    expect(await readCheckoutCommitBlock(repo)).toBe('merge')
  })
})

describe('what the guard is protecting', () => {
  it('is a save that would otherwise leave the brain staged in a conflicted index', async () => {
    conflictedMerge()
    writeFileSync(path.join(repo, '.buildex', 'decisions', 'pricing.md'), '# Pricing v2\n', 'utf8')

    // Left unguarded: `git add` succeeds, the partial commit behind it does not,
    // and the brain is now staged inside the merge the operator is about to
    // finish. This is why the handlers check first rather than catching after.
    const attempted = await commitBrain(embeddedLocation(repo), 'Raised the floor')

    expect(attempted.ok).toBe(false)
    expect(
      execFileSync('git', ['status', '--porcelain', '--', '.buildex'], {
        cwd: repo,
        encoding: 'utf8'
      }).trim()
    ).toBe('M  .buildex/decisions/pricing.md')
    expect(await readCheckoutCommitBlock(repo)).toBe('merge')
  })
})

describe('checkoutCommitBlockMessage', () => {
  it('names the operation and the checkout the operator has to go fix', () => {
    const message = checkoutCommitBlockMessage('rebase', '/code/acme')

    expect(message).toContain('rebase')
    expect(message).toContain('/code/acme')
  })

  it('tells the operator to check a branch out, which is a different instruction', () => {
    const message = checkoutCommitBlockMessage('detached-head', '/code/acme')

    expect(message).toContain('/code/acme')
    expect(message).toContain('branch')
    expect(message).not.toContain('abort')
  })
})
