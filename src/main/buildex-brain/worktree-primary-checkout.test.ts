import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { primaryCheckoutPath } from './worktree-primary-checkout'

let dir = ''
let repo = ''

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'buildex-primary-'))
  repo = path.join(dir, 'api')
  mkdirSync(path.join(repo, '.git', 'worktrees', 'feature'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function checkoutPointingAt(gitDir: string): string {
  const at = path.join(dir, 'checkout')
  mkdirSync(at, { recursive: true })
  writeFileSync(path.join(at, '.git'), `gitdir: ${gitDir}\n`, 'utf8')
  return at
}

describe('primaryCheckoutPath', () => {
  it('walks a linked worktree back to the checkout that owns it', () => {
    const worktree = checkoutPointingAt(path.join(repo, '.git', 'worktrees', 'feature'))

    expect(primaryCheckoutPath(worktree)).toBe(repo)
  })

  it('accepts a relative gitdir, which is what a portable worktree records', () => {
    const at = path.join(dir, 'checkout')
    mkdirSync(at, { recursive: true })
    writeFileSync(
      path.join(at, '.git'),
      `gitdir: ${path.join('..', 'api', '.git', 'worktrees', 'feature')}\n`,
      'utf8'
    )

    expect(primaryCheckoutPath(at)).toBe(repo)
  })

  it('has no answer for the primary checkout itself', () => {
    expect(primaryCheckoutPath(repo)).toBeNull()
  })

  it('has no answer for a folder that is not a checkout', () => {
    expect(primaryCheckoutPath(path.join(dir, 'nowhere'))).toBeNull()
  })

  it('refuses a separate git dir, which is not a worktree and owns no checkout', () => {
    // `git init --separate-git-dir` and submodules also leave a `.git` file, and
    // the folder above their git dir is not a checkout to look for a brain in.
    const separate = path.join(dir, 'elsewhere', 'api.git')
    mkdirSync(separate, { recursive: true })

    expect(primaryCheckoutPath(checkoutPointingAt(separate))).toBeNull()
  })

  it('refuses a worktree of a bare repo, which has no primary checkout', () => {
    const bare = path.join(dir, 'api.git')
    mkdirSync(path.join(bare, 'worktrees', 'feature'), { recursive: true })

    const worktree = checkoutPointingAt(path.join(bare, 'worktrees', 'feature'))

    expect(primaryCheckoutPath(worktree)).toBeNull()
  })
})
