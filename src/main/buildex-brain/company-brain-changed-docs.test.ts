import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { embeddedLocation, externalLocation } from './brain-location'
import { listChangedDocumentIds } from './company-brain-changed-docs'

let repo = ''

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo })
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-changed-docs-'))
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('an embedded brain', () => {
  it('strips the .buildex/ prefix from a changed document id', async () => {
    mkdirSync(path.join(repo, '.buildex', 'decisions'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'decisions', 'pricing.md'), '# Pricing\n', 'utf8')

    expect(await listChangedDocumentIds(embeddedLocation(repo))).toEqual(['decisions/pricing.md'])
  })
})

describe('an external brain', () => {
  it('keeps a changed document id brain-relative, unstripped', async () => {
    mkdirSync(path.join(repo, 'decisions'), { recursive: true })
    writeFileSync(path.join(repo, 'decisions', 'pricing.md'), '# Pricing\n', 'utf8')

    expect(await listChangedDocumentIds(externalLocation(repo))).toEqual(['decisions/pricing.md'])
  })
})
