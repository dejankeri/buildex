import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { embeddedLocation, externalLocation } from './brain-location'
import { parseChangedBrainPaths, readChangedBrainPaths } from './brain-git-paths'
import { listChangedDocumentIds } from './company-brain-changed-docs'

// One parser, both call sites. The rename case is why: the origin record git
// emits after a rename carries no status field, so reading it like one reports
// a path three characters short of a real file.

let repo = ''

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo })
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-git-paths-'))
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('parseChangedBrainPaths', () => {
  it('keeps the destination of a rename and drops the origin record', () => {
    const stdout = 'R  clients/acme.md\0clients/acme-corp.md\0 M rules/operating.md\0'

    expect(parseChangedBrainPaths(externalLocation(repo), stdout)).toEqual([
      'clients/acme.md',
      'rules/operating.md'
    ])
  })

  it('does the same for a copy, whose origin record is shaped identically', () => {
    const stdout = 'C  clients/beta.md\0clients/acme.md\0'

    expect(parseChangedBrainPaths(externalLocation(repo), stdout)).toEqual(['clients/beta.md'])
  })
})

describe('a renamed brain document, read from a real repo', () => {
  beforeEach(() => {
    mkdirSync(path.join(repo, 'clients'), { recursive: true })
    writeFileSync(path.join(repo, 'clients', 'acme-corp.md'), '# Acme Corp\n', 'utf8')
    git('add', '.')
    git('commit', '--quiet', '-m', 'First')
    git('mv', path.join('clients', 'acme-corp.md'), path.join('clients', 'acme.md'))
  })

  it('reports only the path that now exists', async () => {
    expect(await readChangedBrainPaths(externalLocation(repo))).toEqual(['clients/acme.md'])
  })

  it('reports the same through the document call site', async () => {
    expect(await listChangedDocumentIds(externalLocation(repo))).toEqual(['clients/acme.md'])
  })
})

describe('an embedded brain', () => {
  it('strips the .buildex/ prefix, and lists attachments only for the path caller', async () => {
    mkdirSync(path.join(repo, '.buildex', 'decisions'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'decisions', 'pricing.md'), '# Pricing\n', 'utf8')
    writeFileSync(path.join(repo, '.buildex', 'decisions', 'deck.pdf'), 'binary', 'utf8')

    expect(await readChangedBrainPaths(embeddedLocation(repo))).toEqual([
      'decisions/deck.pdf',
      'decisions/pricing.md'
    ])
    expect(await listChangedDocumentIds(embeddedLocation(repo))).toEqual(['decisions/pricing.md'])
  })
})

describe('a folder that is no git repo', () => {
  it('reports nothing rather than failing the view', async () => {
    const loose = mkdtempSync(path.join(tmpdir(), 'buildex-git-paths-loose-'))
    try {
      expect(await readChangedBrainPaths(externalLocation(loose))).toEqual([])
    } finally {
      rmSync(loose, { recursive: true, force: true })
    }
  })
})
