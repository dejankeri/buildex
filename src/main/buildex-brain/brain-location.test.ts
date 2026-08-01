import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scaffoldCompanyBrain } from './brain-scaffold'
import { bindRepoToBrain, readBrainBindings, rememberClone } from './brain-bindings'
import {
  bindExistingBrain,
  readBrainPointer,
  removeBrainPointer,
  resolveBrainLocation,
  suggestedClonePath,
  writeBrainPointer
} from './brain-location'

let dir = ''
let repo = ''
let brain = ''
let bindingsFile = ''

/** A directory that passes the "is it a git repo" check without running git. */
function makeGitRepo(at: string): void {
  mkdirSync(path.join(at, '.git'), { recursive: true })
}

/** A linked worktree of `of`, laid out the way `git worktree add` leaves one. */
function makeWorktree(of: string, at: string, name: string): string {
  mkdirSync(at, { recursive: true })
  mkdirSync(path.join(of, '.git', 'worktrees', name), { recursive: true })
  writeFileSync(
    path.join(at, '.git'),
    `gitdir: ${path.join(of, '.git', 'worktrees', name)}\n`,
    'utf8'
  )
  return at
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'buildex-location-'))
  repo = path.join(dir, 'api')
  brain = path.join(dir, 'acme-brain')
  bindingsFile = path.join(dir, 'brains.json')
  mkdirSync(repo, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveBrainLocation', () => {
  it('is embedded when nothing points anywhere else', () => {
    const result = resolveBrainLocation(repo, { bindingsFile })

    expect(result).toEqual({
      status: 'ready',
      location: {
        root: path.join(repo, '.buildex'),
        gitRoot: repo,
        pathspec: '.buildex',
        mode: 'embedded'
      }
    })
  })

  it('uses the machine-local binding when there is one', () => {
    makeGitRepo(brain)
    bindRepoToBrain(repo, brain, bindingsFile)

    const result = resolveBrainLocation(repo, { bindingsFile })

    expect(result).toEqual({
      status: 'ready',
      location: { root: brain, gitRoot: brain, pathspec: '.', mode: 'external' }
    })
  })

  it('lets the tracked pointer win over the local binding', () => {
    makeGitRepo(brain)
    const other = path.join(dir, 'other-brain')
    makeGitRepo(other)
    bindRepoToBrain(repo, other, bindingsFile)
    writeBrainPointer(repo, 'git@github.com:acme/brain.git')
    rememberClone('git@github.com:acme/brain.git', brain, bindingsFile)

    const result = resolveBrainLocation(repo, { bindingsFile })

    // Why: the pointer is the company's choice and travels with the clone; the
    // binding is one person's. The company wins.
    expect(result).toEqual({
      status: 'ready',
      location: {
        root: brain,
        gitRoot: brain,
        pathspec: '.',
        mode: 'external',
        remote: 'git@github.com:acme/brain.git'
      }
    })
  })

  it('asks for a clone when the pointer names a brain this machine lacks', () => {
    writeBrainPointer(repo, 'git@github.com:acme/brain.git')

    const result = resolveBrainLocation(repo, { bindingsFile })

    expect(result).toEqual({
      status: 'needs-clone',
      remote: 'git@github.com:acme/brain.git',
      suggestedPath: suggestedClonePath('git@github.com:acme/brain.git')
    })
  })

  it('reports a bound brain whose folder has gone', () => {
    bindRepoToBrain(repo, brain, bindingsFile)

    const result = resolveBrainLocation(repo, { bindingsFile })

    expect(result).toEqual({ status: 'broken', reason: 'missing', path: brain })
  })

  it('reports a bound folder that is not a git repo', () => {
    mkdirSync(brain, { recursive: true })

    bindRepoToBrain(repo, brain, bindingsFile)

    expect(resolveBrainLocation(repo, { bindingsFile })).toEqual({
      status: 'broken',
      reason: 'not-a-repo',
      path: brain
    })
  })

  it('reaches the binding of the primary checkout from a worktree', () => {
    makeGitRepo(repo)
    makeGitRepo(brain)
    bindRepoToBrain(repo, brain, bindingsFile)
    const worktree = makeWorktree(repo, path.join(dir, 'api-feature'), 'api-feature')

    // The binding names the path the operator set the brain up in. A worktree is
    // the same repo at another path, and without this the brain is simply gone
    // there — the complaint that produced this test.
    expect(resolveBrainLocation(worktree, { bindingsFile })).toEqual({
      status: 'ready',
      location: { root: brain, gitRoot: brain, pathspec: '.', mode: 'external' }
    })
  })

  it('reads the pointer of the primary checkout when this worktree lacks one', () => {
    makeGitRepo(repo)
    makeGitRepo(brain)
    writeBrainPointer(repo, 'git@github.com:acme/brain.git')
    rememberClone('git@github.com:acme/brain.git', brain, bindingsFile)
    const worktree = makeWorktree(repo, path.join(dir, 'api-feature'), 'api-feature')

    // An uncommitted pointer is in no other checkout, and a committed one is
    // missing from any worktree on a branch that predates it.
    expect(resolveBrainLocation(worktree, { bindingsFile })).toEqual({
      status: 'ready',
      location: {
        root: brain,
        gitRoot: brain,
        pathspec: '.',
        mode: 'external',
        remote: 'git@github.com:acme/brain.git'
      }
    })
  })

  it("keeps an embedded brain the worktree's own", () => {
    makeGitRepo(repo)
    const worktree = makeWorktree(repo, path.join(dir, 'api-feature'), 'api-feature')

    // `.buildex/` is branch content: a worktree writing the primary checkout's
    // copy would put the company's documents on the wrong branch.
    expect(resolveBrainLocation(worktree, { bindingsFile })).toEqual({
      status: 'ready',
      location: {
        root: path.join(worktree, '.buildex'),
        gitRoot: worktree,
        pathspec: '.buildex',
        mode: 'embedded'
      }
    })
  })

  it("lets a worktree's own pointer win over the primary checkout's", () => {
    makeGitRepo(repo)
    makeGitRepo(brain)
    const other = path.join(dir, 'other-brain')
    makeGitRepo(other)
    writeBrainPointer(repo, 'git@github.com:acme/old.git')
    rememberClone('git@github.com:acme/old.git', other, bindingsFile)
    const worktree = makeWorktree(repo, path.join(dir, 'api-feature'), 'api-feature')
    writeBrainPointer(worktree, 'git@github.com:acme/brain.git')
    rememberClone('git@github.com:acme/brain.git', brain, bindingsFile)

    // The fallback is for a worktree with no answer of its own; a branch that
    // moved the brain must still be read on its own terms.
    expect(resolveBrainLocation(worktree, { bindingsFile })).toEqual({
      status: 'ready',
      location: {
        root: brain,
        gitRoot: brain,
        pathspec: '.',
        mode: 'external',
        remote: 'git@github.com:acme/brain.git'
      }
    })
  })

  it('ignores a pointer file that is not ours', () => {
    mkdirSync(path.join(repo, '.buildex'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'brain.json'), '{"nope":true}', 'utf8')

    expect(readBrainPointer(repo)).toBeNull()
    expect(resolveBrainLocation(repo, { bindingsFile }).status).toBe('ready')
  })
})

describe('the pointer file', () => {
  it('round-trips a remote', () => {
    writeBrainPointer(repo, 'git@github.com:acme/brain.git')

    expect(readBrainPointer(repo)).toBe('git@github.com:acme/brain.git')
  })

  it('is removable without taking the folder with it', () => {
    writeBrainPointer(repo, 'git@github.com:acme/brain.git')

    removeBrainPointer(repo)

    expect(readBrainPointer(repo)).toBeNull()
  })
})

describe('suggestedClonePath', () => {
  it('names the folder after the repo, not the whole URL', () => {
    expect(path.basename(suggestedClonePath('git@github.com:acme/brain.git'))).toBe('brain')
    expect(path.basename(suggestedClonePath('https://github.com/acme/company-brain'))).toBe(
      'company-brain'
    )
  })

  it('never lets a remote walk the suggested path out of brains/', () => {
    // The remote comes from a tracked file this machine did not write, and a
    // name of `..` normalises away a whole directory — this one used to
    // suggest `~/.buildex`.
    const suggested = suggestedClonePath('git@github.com:acme/..')

    expect(path.basename(suggested)).toBe('acme')
    expect(suggested).toContain(path.join('.buildex', 'brains'))
  })
})

describe('bindExistingBrain', () => {
  it('records a machine-local binding when the operator declined a pointer', async () => {
    makeGitRepo(brain)

    const result = await bindExistingBrain({
      repoPath: repo,
      brainPath: brain,
      writePointer: false,
      bindingsFile
    })

    expect(result.ok).toBe(true)
    expect(readBrainBindings(bindingsFile).brainByRepo[repo]).toBe(brain)
    expect(readBrainPointer(repo)).toBeNull()
  })

  it('writes a tracked pointer and remembers the clone when a remote is given', async () => {
    makeGitRepo(brain)

    const result = await bindExistingBrain({
      repoPath: repo,
      brainPath: brain,
      remote: 'git@github.com:acme/brain.git',
      writePointer: true,
      bindingsFile
    })

    expect(result.ok).toBe(true)
    expect(readBrainPointer(repo)).toBe('git@github.com:acme/brain.git')
    expect(readBrainBindings(bindingsFile).clonesByRemote['git@github.com:acme/brain.git']).toBe(
      brain
    )
  })

  it('falls back to a machine-local binding when a pointer was asked for but no remote is known', async () => {
    makeGitRepo(brain)

    const result = await bindExistingBrain({
      repoPath: repo,
      brainPath: brain,
      writePointer: true,
      bindingsFile
    })

    expect(result.ok).toBe(true)
    expect(readBrainPointer(repo)).toBeNull()
    expect(readBrainBindings(bindingsFile).brainByRepo[repo]).toBe(brain)
  })

  it('refuses a brain path that does not exist', async () => {
    const result = await bindExistingBrain({
      repoPath: repo,
      brainPath: path.join(dir, 'nowhere'),
      writePointer: false,
      bindingsFile
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(readBrainBindings(bindingsFile).brainByRepo[repo]).toBeUndefined()
  })

  it('refuses a brain path that is not a git repo', async () => {
    mkdirSync(brain, { recursive: true })

    const result = await bindExistingBrain({
      repoPath: repo,
      brainPath: brain,
      writePointer: false,
      bindingsFile
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(readBrainBindings(bindingsFile).brainByRepo[repo]).toBeUndefined()
  })
})

describe('bindExistingBrain and the brain it binds to', () => {
  it('gives this repo the skills the brain already holds', async () => {
    makeGitRepo(brain)
    mkdirSync(path.join(brain, 'skills', 'slack-search'), { recursive: true })
    writeFileSync(path.join(brain, 'skills', 'slack-search', 'SKILL.md'), '# Slack\n', 'utf8')

    await bindExistingBrain({ repoPath: repo, brainPath: brain, writePointer: false, bindingsFile })

    // The design's whole point: install an app once and every repo bound to
    // that brain gets it. Without this the repo has no skills until something
    // else happens to relink.
    expect(realpathSync(path.join(repo, '.claude', 'skills', 'slack-search'))).toBe(
      realpathSync(path.join(brain, 'skills', 'slack-search'))
    )
  })
})

describe('the pristine-repo external setup path', () => {
  // The scenario the plan's Task 13 silently mishandled: a company chooses
  // "in a separate brain repo" on day one, before this repo has ever had an
  // embedded `.buildex/`. `migrateBrainToExternal` has nothing to move here —
  // `bindExistingBrain` is the operation this path actually needs.
  it('binds the repo and scaffolds sections into the external brain, never <repo>/.buildex', async () => {
    makeGitRepo(brain)
    expect(existsSync(path.join(repo, '.buildex'))).toBe(false)

    const bound = await bindExistingBrain({
      repoPath: repo,
      brainPath: brain,
      writePointer: false,
      bindingsFile
    })
    expect(bound.ok).toBe(true)

    const resolution = resolveBrainLocation(repo, { bindingsFile })
    expect(resolution).toEqual({
      status: 'ready',
      location: { root: brain, gitRoot: brain, pathspec: '.', mode: 'external' }
    })
    if (resolution.status !== 'ready') {
      throw new Error('expected the brain to resolve')
    }

    const scaffolded = scaffoldCompanyBrain(resolution.location, {
      folders: ['strategy'],
      summary: 'A pristine-repo brain'
    })

    expect(scaffolded.created).toContain('strategy/')
    expect(existsSync(path.join(brain, 'strategy', 'overview.md'))).toBe(true)
    expect(existsSync(path.join(repo, '.buildex'))).toBe(false)
  })
})
