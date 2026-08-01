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

describe('migrating from a linked worktree', () => {
  it("moves the primary checkout's brain, and points that checkout at it", async () => {
    // The brain a worktree shows is the primary checkout's, so that is the one
    // the button is offering to move. Looking in the worktree instead would
    // report "there is no brain here to move" over a page full of documents.
    const worktree = path.join(realpathSync(dir), 'api-feature')
    git(repo, 'worktree', 'add', '--quiet', '-b', 'feature', worktree)
    const primary = realpathSync(repo)

    const result = await migrateBrainToExternal(
      { repoPath: worktree, brainPath: brain, writePointer: false, bindingsFile },
      1_700_000_000_000
    )

    expect(result.ok).toBe(true)
    expect(result.movedPaths).toEqual(['decisions/pricing.md'])
    expect(readFileSync(path.join(brain, 'decisions', 'pricing.md'), 'utf8')).toBe('# Pricing\n')
    expect(existsSync(path.join(repo, '.buildex', 'decisions'))).toBe(false)
    // The binding names the checkout the brain actually left, so every worktree
    // of this repo resolves to it through the same primary-checkout fallback.
    expect(JSON.parse(readFileSync(bindingsFile, 'utf8')).brainByRepo[primary]).toBe(brain)
    rmSync(result.backupPath ?? '', { recursive: true, force: true })
  })
})

describe('migrating out of a checkout that cannot take the commit', () => {
  it('refuses before the backup rather than deleting the files and reporting success', async () => {
    // Unguarded this is the worst reachable shape of the mid-merge hazard:
    // `git rm --ignore-unmatch` exits 0 and stages the deletion, the partial
    // commit exits 128 into a bare catch, and migrate goes on to delete the
    // files from disk and return ok — leaving the brain in HEAD and its removal
    // staged in somebody else's conflicted index.
    mkdirSync(path.join(repo, 'src'), { recursive: true })
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'base\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'code')
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

    const result = await migrateBrainToExternal(
      { repoPath: repo, brainPath: brain, writePointer: false, bindingsFile },
      1_700_000_000_000
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('merge')
    expect(result.backupPath).toBeUndefined()
    // Nothing moved, nothing deleted, nothing staged.
    expect(readFileSync(path.join(repo, '.buildex', 'decisions', 'pricing.md'), 'utf8')).toBe(
      '# Pricing\n'
    )
    expect(existsSync(path.join(brain, 'decisions'))).toBe(false)
    expect(
      execFileSync('git', ['status', '--porcelain', '--', '.buildex'], {
        cwd: repo,
        encoding: 'utf8'
      }).trim()
    ).toBe('')
  })

  it('refuses when the brain repo it is moving into is mid-merge', async () => {
    // The target is a repo the operator picked, and `commitBrain` there stages
    // before it commits just the same.
    writeFileSync(path.join(brain, 'seed.md'), 'a\n', 'utf8')
    git(brain, 'add', '.')
    git(brain, 'commit', '--quiet', '-m', 'first')
    git(brain, 'checkout', '--quiet', '-b', 'other')
    writeFileSync(path.join(brain, 'seed.md'), 'theirs\n', 'utf8')
    git(brain, 'commit', '--quiet', '-am', 'Theirs')
    git(brain, 'checkout', '--quiet', '-')
    writeFileSync(path.join(brain, 'seed.md'), 'ours\n', 'utf8')
    git(brain, 'commit', '--quiet', '-am', 'Ours')
    try {
      git(brain, 'merge', 'other')
    } catch {
      // The conflict is the point.
    }

    const result = await migrateBrainToExternal(
      { repoPath: repo, brainPath: brain, writePointer: false, bindingsFile },
      1_700_000_000_000
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('merge')
    expect(existsSync(path.join(repo, '.buildex', 'decisions', 'pricing.md'))).toBe(true)
  })
})

describe('migrating a brain the primary checkout never had, with a tracked pointer', () => {
  // The combination the placement split created and nothing exercised: the
  // documents live in the worktree (so the git rm and its commit run there),
  // while the pointer is recorded in the primary (so its commit must run
  // there). One commit in one checkout cannot do both.
  it('commits the pointer in the checkout it was staged in, leaving nothing staged', async () => {
    const worktree = path.join(realpathSync(dir), 'api-feature')
    git(repo, 'worktree', 'add', '--quiet', '-b', 'feature', worktree)
    const primary = realpathSync(repo)
    // The primary's branch drops the brain; the worktree's branch keeps it.
    // That is the shape every pre-convergence worktree upgrades into.
    git(repo, 'rm', '-r', '--quiet', '--', '.buildex')
    git(repo, 'commit', '--quiet', '-m', 'no brain here')

    const result = await migrateBrainToExternal(
      {
        repoPath: worktree,
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

    // The pointer is recorded in the primary, and it is *committed* there — not
    // left staged in a checkout the operator is not looking at, where the next
    // unrelated commit would sweep it up.
    expect(readBrainPointer(primary)).toBe('git@github.com:acme/brain.git')
    expect(
      execFileSync('git', ['status', '--porcelain', '--', '.buildex'], {
        cwd: primary,
        encoding: 'utf8'
      })
    ).toBe('')
    expect(
      execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], {
        cwd: primary,
        encoding: 'utf8'
      }).trim()
    ).toBe('.buildex/brain.json')

    // And the worktree's own branch carries the removal, on its own commit.
    expect(existsSync(path.join(worktree, '.buildex', 'decisions'))).toBe(false)
    expect(
      execFileSync('git', ['status', '--porcelain', '--', '.buildex'], {
        cwd: worktree,
        encoding: 'utf8'
      })
    ).toBe('')
    rmSync(result.backupPath ?? '', { recursive: true, force: true })
  })
})
