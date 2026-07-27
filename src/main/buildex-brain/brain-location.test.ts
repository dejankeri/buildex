import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindRepoToBrain, rememberClone, setDefaultBrain } from './brain-bindings'
import {
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

  it('falls back to the machine-wide default brain', () => {
    makeGitRepo(brain)
    setDefaultBrain(brain, bindingsFile)

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
})
