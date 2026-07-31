import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The home directory bounds the walk up to a checkout, so the tests need one
// they own — the real `$HOME` may or may not be a git repo on any given machine.
let home = ''
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => home
}))

const { resolveCompanyIdentity } = await import('./buildex-company-identity')

// The worktree layout is written by hand rather than by git: this resolver reads
// `.git` directly, so a real `git worktree add` would prove nothing extra and
// would cost a process per test.

let dir = ''
let acme = ''

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'buildex-company-'))
  home = path.join(dir, 'home')
  mkdirSync(home, { recursive: true })
  acme = path.join(dir, 'acme')
  mkdirSync(path.join(acme, '.git', 'worktrees', 'feature'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function linkedWorktree(name: string): string {
  const at = path.join(dir, name)
  mkdirSync(at, { recursive: true })
  writeFileSync(path.join(at, '.git'), `gitdir: ${path.join(acme, '.git', 'worktrees', name)}\n`)
  return at
}

function plainRepo(name: string): string {
  const at = path.join(dir, name)
  mkdirSync(path.join(at, '.git'), { recursive: true })
  return at
}

describe('resolveCompanyIdentity', () => {
  it('gives two worktrees of one company the same key', () => {
    mkdirSync(path.join(acme, '.git', 'worktrees', 'invoices'), { recursive: true })

    const feature = resolveCompanyIdentity(linkedWorktree('feature'))
    const invoices = resolveCompanyIdentity(linkedWorktree('invoices'))

    expect(feature?.key).toBe(invoices?.key)
    expect(feature?.root).toBe(invoices?.root)
  })

  it('gives a worktree the same key as the checkout it came from', () => {
    expect(resolveCompanyIdentity(linkedWorktree('feature'))?.key).toBe(
      resolveCompanyIdentity(acme)?.key
    )
  })

  it('gives a subdirectory the same key as its checkout, so `cd packages/api` is one company', () => {
    const nested = path.join(acme, 'packages', 'api')
    mkdirSync(nested, { recursive: true })

    expect(resolveCompanyIdentity(nested)?.key).toBe(resolveCompanyIdentity(acme)?.key)
  })

  it('gives two companies different keys', () => {
    expect(resolveCompanyIdentity(acme)?.key).not.toBe(
      resolveCompanyIdentity(plainRepo('beta'))?.key
    )
  })

  it('answers the same thing every time, so a restart finds the same keys', () => {
    expect(resolveCompanyIdentity(acme)?.key).toBe(resolveCompanyIdentity(acme)?.key)
  })

  it('sees through a symlinked path to the one company behind it', () => {
    const link = path.join(dir, 'acme-link')
    symlinkSync(acme, link, 'dir')

    expect(resolveCompanyIdentity(link)?.key).toBe(resolveCompanyIdentity(acme)?.key)
  })

  it('names a folder workspace by itself, which is the identity it has', () => {
    // A business run out of a plain folder is a supported shape, and a folder
    // outside a repo has no aliasing to undo — the path is all there is.
    const folder = path.join(dir, 'consulting')
    mkdirSync(folder, { recursive: true })

    const identity = resolveCompanyIdentity(folder)

    expect(identity?.key).toMatch(/^consulting-[0-9a-f]{16}$/)
    expect(identity?.root).toBe(realpathSync.native(folder))
    expect(resolveCompanyIdentity(folder)?.key).toBe(identity?.key)
  })

  it('keeps a folder workspace and a repo apart', () => {
    const folder = path.join(dir, 'consulting')
    mkdirSync(folder, { recursive: true })

    expect(resolveCompanyIdentity(folder)?.key).not.toBe(resolveCompanyIdentity(acme)?.key)
  })

  it('prefers the repo when a folder workspace turns out to be inside one', () => {
    const nested = path.join(acme, 'ops')
    mkdirSync(nested, { recursive: true })

    expect(resolveCompanyIdentity(nested)?.key).toBe(resolveCompanyIdentity(acme)?.key)
  })

  it('does not let a repo at the home directory swallow every business under it', () => {
    // `git init ~` is an ordinary dotfiles setup. Walking through it would make
    // every business one business and pool their credentials — a false merge,
    // which is the worse error of the two.
    mkdirSync(path.join(home, '.git'), { recursive: true })
    const first = path.join(home, 'acme')
    const second = path.join(home, 'beta')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })

    expect(resolveCompanyIdentity(first)?.root).toBe(realpathSync.native(first))
    expect(resolveCompanyIdentity(first)?.key).not.toBe(resolveCompanyIdentity(second)?.key)
    expect(resolveCompanyIdentity(home)?.root).toBe(realpathSync.native(home))
  })

  it('still collapses a business onto its own repo below the home directory', () => {
    // The bound stops at home, not at the first repo: a real checkout under it
    // must still gather its own subdirectories.
    const repo = path.join(home, 'work', 'acme')
    const nested = path.join(repo, 'packages', 'api')
    mkdirSync(path.join(repo, '.git'), { recursive: true })
    mkdirSync(nested, { recursive: true })

    expect(resolveCompanyIdentity(nested)?.root).toBe(realpathSync.native(repo))
  })

  it('has no company for a path this machine cannot see, which is what an SSH workspace is', () => {
    expect(resolveCompanyIdentity(path.join(dir, 'nowhere', 'deep'))).toBeNull()
  })

  it('has no company for an absent, empty or blank path', () => {
    expect(resolveCompanyIdentity(undefined)).toBeNull()
    expect(resolveCompanyIdentity('')).toBeNull()
    expect(resolveCompanyIdentity('   ')).toBeNull()
  })

  it('mints a key that is a legal directory name on macOS, Linux and Windows alike', () => {
    // Lowercase [a-z0-9-] with a hex tail: no separator, no dot for Windows to
    // read a device name out of, no case-only collision on APFS, nothing to
    // escape the credential folder with.
    const key = resolveCompanyIdentity(plainRepo('Acme Ltd. (US) ..'))?.key

    expect(key).toMatch(/^[a-z0-9][a-z0-9-]*-[0-9a-f]{16}$/)
    expect(key!.length).toBeLessThanOrEqual(41)
  })

  it('names the company in the key so an operator can tell the folders apart', () => {
    expect(resolveCompanyIdentity(plainRepo('acme-invoices'))?.key).toMatch(/^acme-invoices-/)
  })

  it('falls back to a usable name when the folder has nothing nameable in it', () => {
    expect(resolveCompanyIdentity(plainRepo('___'))?.key).toMatch(/^company-[0-9a-f]{16}$/)
  })
})
