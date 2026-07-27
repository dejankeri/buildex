import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanCompanyBrain } from './company-brain-service'

let repo = ''

// The brain is `.buildex/`, so fixtures are written there and referred to by the
// id the scanner reports — relative to that folder, not the repo.
function write(relativePath: string, contents: string): void {
  const absolute = path.join(repo, '.buildex', relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-brain-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('scanCompanyBrain', () => {
  it('builds a link graph from wikilinks and relative markdown links', async () => {
    write(
      'knowledge/method.md',
      '# Method\nSee [[operating]] and [engagement](../templates/engagement.md).'
    )
    write('rules/operating.md', '# Operating')
    write('templates/engagement.md', '# Engagement')

    const scan = await scanCompanyBrain(repo, 1)
    const method = scan.documents.find((d) => d.id === 'knowledge/method.md')

    expect(method?.linksTo).toEqual(['rules/operating.md', 'templates/engagement.md'])
    expect(scan.documents.find((d) => d.id === 'rules/operating.md')?.linkedFrom).toEqual([
      'knowledge/method.md'
    ])
    expect(scan.totalLinks).toBe(2)
  })

  it('is deterministic across repeated scans', async () => {
    write('a.md', '# A\n[[b]] [[c]]')
    write('b.md', '# B\n[[c]]')
    write('c.md', '# C')

    const first = await scanCompanyBrain(repo, 1)
    const second = await scanCompanyBrain(repo, 1)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('drops links that leave the repo or point at missing documents', async () => {
    write('a.md', '# A\n[[nowhere]] [up](../../escape.md) [gone](./missing.md)')

    const scan = await scanCompanyBrain(repo, 1)

    expect(scan.documents[0]?.linksTo).toEqual([])
    expect(scan.totalLinks).toBe(0)
  })

  it('ignores links inside code fences', async () => {
    write('a.md', '# A\n```\n[[b]]\n```\nand `[[b]]` inline')
    write('b.md', '# B')

    const scan = await scanCompanyBrain(repo, 1)

    expect(scan.documents.find((d) => d.id === 'a.md')?.linksTo).toEqual([])
  })

  it('excludes skill manifests and dot/ignored directories', async () => {
    write('skills/deploy/SKILL.md', '# Deploy skill')
    write('node_modules/pkg/readme.md', '# Vendor')
    write('.hidden/secret.md', '# Hidden')
    write('keep.md', '# Keep')

    const scan = await scanCompanyBrain(repo, 1)

    expect(scan.documents.map((d) => d.id)).toEqual(['keep.md'])
  })

  it('reports orphans and folder counts', async () => {
    write('linked-a.md', '[[linked-b]]')
    write('linked-b.md', '# B')
    write('notes/lonely.md', '# Lonely')

    const scan = await scanCompanyBrain(repo, 1)

    expect(scan.orphanIds).toEqual(['notes/lonely.md'])
    expect(scan.folders).toEqual([
      { path: '', documentCount: 2 },
      { path: 'notes', documentCount: 1 }
    ])
  })

  it('resolves wikilinks with labels and heading anchors', async () => {
    write('a.md', '[[target|Nice label]] and [[target#section]]')
    write('target.md', '# Target')

    const scan = await scanCompanyBrain(repo, 1)

    expect(scan.documents.find((d) => d.id === 'a.md')?.linksTo).toEqual(['target.md'])
  })

  it('returns an empty scan for a directory with no markdown', async () => {
    mkdirSync(path.join(repo, 'empty'), { recursive: true })

    const scan = await scanCompanyBrain(repo, 7)

    expect(scan.documents).toEqual([])
    expect(scan.scannedAt).toBe(7)
  })
})
