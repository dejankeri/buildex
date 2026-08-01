import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { embeddedLocation, externalLocation } from './brain-location'
import { listRecentlyChangedDocuments } from './brain-recent-documents'

// Every case here shells out to real `git`, repeatedly. Vitest's 5s default is a
// budget for pure functions, and under full-suite load these are the files that
// turn a loaded box into a red suite — the noise that hides a real regression.
vi.setConfig({ testTimeout: 60_000 })

// Against a real git repo: the risk here is what `git log --name-only -z`
// actually emits — through a pathspec, for a non-ASCII path, and in a repo with
// no commits at all. A stubbed runner would only prove the parser agrees with
// itself.

let repo = ''

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo })
}

function write(relative: string, body: string): void {
  const absolute = path.join(repo, relative)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, body, 'utf8')
}

function commit(message: string): void {
  git('add', '-A')
  git('commit', '-qm', message)
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-recent-'))
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('listRecentlyChangedDocuments', () => {
  it('lists brain-relative ids newest first', async () => {
    write('.buildex/decisions/pricing.md', '# Pricing\n')
    write('.buildex/rules/operating.md', '# Operating\n')
    commit('first')
    write('.buildex/rules/operating.md', '# Operating\n\nMore.\n')
    commit('second')

    const recent = await listRecentlyChangedDocuments(
      embeddedLocation(repo),
      new Set(['decisions/pricing.md', 'rules/operating.md']),
      10
    )

    expect(recent).toEqual(['rules/operating.md', 'decisions/pricing.md'])
  })

  it('names a document once, at its most recent change', async () => {
    write('.buildex/a.md', '1\n')
    commit('one')
    write('.buildex/b.md', '1\n')
    commit('two')
    write('.buildex/a.md', '2\n')
    commit('three')

    const recent = await listRecentlyChangedDocuments(
      embeddedLocation(repo),
      new Set(['a.md', 'b.md']),
      10
    )

    expect(recent).toEqual(['a.md', 'b.md'])
  })

  it('drops a path the brain no longer holds', async () => {
    // A deleted document is still in the history and is nowhere to send anyone.
    write('.buildex/gone.md', '# Gone\n')
    write('.buildex/kept.md', '# Kept\n')
    commit('first')
    rmSync(path.join(repo, '.buildex', 'gone.md'))
    commit('removed it')

    const recent = await listRecentlyChangedDocuments(
      embeddedLocation(repo),
      new Set(['kept.md']),
      10
    )

    expect(recent).toEqual(['kept.md'])
  })

  it('ignores what changed outside the brain', async () => {
    write('src/index.ts', 'export {}\n')
    write('.buildex/a.md', '# A\n')
    commit('first')
    write('src/index.ts', 'export const x = 1\n')
    commit('code only')

    const recent = await listRecentlyChangedDocuments(embeddedLocation(repo), new Set(['a.md']), 10)

    expect(recent).toEqual(['a.md'])
  })

  it('reads a non-ASCII path, which git would otherwise octal-quote', async () => {
    write('.buildex/décisions/tarifs.md', '# Tarifs\n')
    commit('first')

    const recent = await listRecentlyChangedDocuments(
      embeddedLocation(repo),
      new Set(['décisions/tarifs.md']),
      10
    )

    expect(recent).toEqual(['décisions/tarifs.md'])
  })

  it('honours the limit', async () => {
    for (const name of ['a', 'b', 'c', 'd']) {
      write(`.buildex/${name}.md`, '# x\n')
      commit(name)
    }

    const recent = await listRecentlyChangedDocuments(
      embeddedLocation(repo),
      new Set(['a.md', 'b.md', 'c.md', 'd.md']),
      2
    )

    expect(recent).toEqual(['d.md', 'c.md'])
  })

  it('reports brain-relative ids for an external brain, whose pathspec is `.`', async () => {
    write('decisions/pricing.md', '# Pricing\n')
    commit('first')

    const recent = await listRecentlyChangedDocuments(
      externalLocation(repo),
      new Set(['decisions/pricing.md']),
      10
    )

    expect(recent).toEqual(['decisions/pricing.md'])
  })

  it('degrades to nothing in a repo with no commits yet', async () => {
    write('.buildex/a.md', '# A\n')

    expect(
      await listRecentlyChangedDocuments(embeddedLocation(repo), new Set(['a.md']), 10)
    ).toEqual([])
  })

  it('degrades to nothing where there is no repo at all', async () => {
    // The folder-workspace case, and the case of a brain on a host without git.
    const plain = mkdtempSync(path.join(tmpdir(), 'buildex-no-git-'))
    try {
      expect(
        await listRecentlyChangedDocuments(embeddedLocation(plain), new Set(['a.md']), 10)
      ).toEqual([])
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
