import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanCompanyBrain } from './company-brain-service'
import { embeddedLocation } from './brain-location'
import type { BrainResolution } from '../../shared/buildex-brain-types'

let repo = ''

// Named to avoid shadowing the `scan` result variable each test declares.
function runScan(now: number) {
  const location = embeddedLocation(repo)
  const resolution: BrainResolution = { status: 'ready', location }
  return scanCompanyBrain(repo, location, resolution, now)
}

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

    const scan = await runScan(1)
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

    const first = await runScan(1)
    const second = await runScan(1)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('drops links that leave the repo or point at missing documents', async () => {
    write('a.md', '# A\n[[nowhere]] [up](../../escape.md) [gone](./missing.md)')

    const scan = await runScan(1)

    expect(scan.documents[0]?.linksTo).toEqual([])
    expect(scan.totalLinks).toBe(0)
  })

  it('collects a wikilink that resolves nowhere as a wanted page', async () => {
    // Why: `[[acme-renewal-terms]]` written while writing something else is the
    // company saying it should know that. Dropped, the intention was lost.
    write('clients/acme.md', '# Acme\nSee [[acme-renewal-terms]].')
    write('rules/operating.md', '# Operating\nAlso [[acme-renewal-terms]] and [[escalation]].')

    const scan = await runScan(1)

    expect(scan.wantedPages).toEqual([
      {
        name: 'acme-renewal-terms',
        requestedBy: ['clients/acme.md', 'rules/operating.md'],
        requestedByCount: 2
      },
      { name: 'escalation', requestedBy: ['rules/operating.md'], requestedByCount: 1 }
    ])
  })

  it('does not turn a wanted page into a broken outbound link', async () => {
    // Collecting is not surfacing an error: the document still links nowhere.
    write('a.md', '# A\n[[missing]]')

    const scan = await runScan(1)

    expect(scan.documents[0]?.linksTo).toEqual([])
    expect(scan.orphanIds).toEqual(['a.md'])
    expect(scan.totalLinks).toBe(0)
  })

  it('does not want a page named by a sentence somebody typed into a link', async () => {
    write('a.md', `# A\n[[${'x'.repeat(200)}]]`)

    const scan = await runScan(1)

    expect(scan.wantedPages).toEqual([])
  })

  it('never lets a wanted name carry a newline into the context map', async () => {
    // `[[` closed by a `]]` three lines later matches, because `[^\]]` includes
    // `\n`. Rendered as `- \`name\`` that is a bullet spanning several lines with
    // a code span that opens and never closes — in the file Claude reads in full
    // at the start of every session.
    write('a.md', '# A\n\nSee [[renewal\nterms]] for the detail.\n')

    const scan = await runScan(1)

    expect(scan.wantedPages).toEqual([
      { name: 'renewal terms', requestedBy: ['a.md'], requestedByCount: 1 }
    ])
  })

  it('skips a wanted name holding a backtick, which no code span can escape', async () => {
    write('a.md', '# A\n\n[[weird`name]]\n')

    const scan = await runScan(1)

    expect(scan.wantedPages).toEqual([])
  })

  it('caps the wanted list and its askers at the source, and says the true totals', async () => {
    // Both this and `recentDocumentIds` cross IPC on every scan and sit in the
    // renderer's store; neither surface renders more than a dozen.
    const names = Array.from({ length: 60 }, (_, index) => `[[wanted-${index}]]`).join(' ')
    for (let index = 0; index < 15; index += 1) {
      write(`asker-${String(index).padStart(2, '0')}.md`, `# Asker\n${names}\n`)
    }

    const scan = await runScan(1)

    expect(scan.wantedPageCount).toBe(60)
    expect(scan.wantedPages).toHaveLength(50)
    // The cut keeps the biggest holes: ranked on true counts, then sliced.
    expect(scan.wantedPages[0]?.requestedByCount).toBe(15)
    expect(scan.wantedPages[0]?.requestedBy).toHaveLength(10)
    expect(scan.wantedPages[0]?.requestedBy[0]).toBe('asker-00.md')
  })

  it('does not want a page an unresolved relative path names', async () => {
    // A path is a claim about the filesystem, and a wrong one is a typo — not a
    // page anybody asked to have written.
    write('a.md', '# A\n[gone](./missing.md)')

    const scan = await runScan(1)

    expect(scan.wantedPages).toEqual([])
  })

  it('reads a description from front matter and leaves it off documents with none', async () => {
    write('decisions/pricing.md', '---\ndescription: Why we price per seat.\n---\n\n# Pricing\n')
    write('decisions/plain.md', '# Plain\n')

    const scan = await runScan(1)

    expect(scan.documents.find((d) => d.id === 'decisions/pricing.md')?.description).toBe(
      'Why we price per seat.'
    )
    expect(scan.documents.find((d) => d.id === 'decisions/plain.md')).not.toHaveProperty(
      'description'
    )
  })

  it("prefers an entity's description over the line its main file opens with", async () => {
    write(
      'clients/acme/index.md',
      '---\ndescription: Renews in Q3.\n---\n\n# Acme\n\nBoilerplate.\n'
    )

    const scan = await runScan(1)
    const entity = scan.tree.find((node) => node.path === 'clients')?.children[0]

    expect(entity?.main?.summary).toBe('Renews in Q3.')
  })

  it('summarises past front matter rather than reporting its opening rule', async () => {
    // Without stripping the block, the first line a summary finds is `---`.
    write('clients/acme/index.md', '---\nowner: dana\n---\n\n# Acme\n\nRenews in Q3.\n')

    const scan = await runScan(1)
    const entity = scan.tree.find((node) => node.path === 'clients')?.children[0]

    expect(entity?.main?.summary).toBe('Renews in Q3.')
  })

  it('ignores links inside code fences', async () => {
    write('a.md', '# A\n```\n[[b]]\n```\nand `[[b]]` inline')
    write('b.md', '# B')

    const scan = await runScan(1)

    expect(scan.documents.find((d) => d.id === 'a.md')?.linksTo).toEqual([])
  })

  it('excludes skill manifests and dot/ignored directories', async () => {
    write('skills/deploy/SKILL.md', '# Deploy skill')
    write('node_modules/pkg/readme.md', '# Vendor')
    write('.hidden/secret.md', '# Hidden')
    write('keep.md', '# Keep')

    const scan = await runScan(1)

    expect(scan.documents.map((d) => d.id)).toEqual(['keep.md'])
  })

  it('reports orphans and folder counts', async () => {
    write('linked-a.md', '[[linked-b]]')
    write('linked-b.md', '# B')
    write('notes/lonely.md', '# Lonely')

    const scan = await runScan(1)

    expect(scan.orphanIds).toEqual(['notes/lonely.md'])
    expect(scan.folders).toEqual([
      { path: '', documentCount: 2 },
      { path: 'notes', documentCount: 1 }
    ])
  })

  it('resolves wikilinks with labels and heading anchors', async () => {
    write('a.md', '[[target|Nice label]] and [[target#section]]')
    write('target.md', '# Target')

    const scan = await runScan(1)

    expect(scan.documents.find((d) => d.id === 'a.md')?.linksTo).toEqual(['target.md'])
  })

  it('returns an empty scan for a directory with no markdown', async () => {
    mkdirSync(path.join(repo, 'empty'), { recursive: true })

    const scan = await runScan(7)

    expect(scan.documents).toEqual([])
    expect(scan.scannedAt).toBe(7)
  })
})
