import { describe, expect, it } from 'vitest'
import type { BrainDocument, BrainScan } from '../../../../shared/buildex-brain-types'
import { buildBrainRows, filterDocuments, summarizeScan } from './brain-panel-rows'

function doc(overrides: Partial<BrainDocument> & { id: string }): BrainDocument {
  return {
    name: overrides.id.split('/').pop()!.replace(/\.md$/, ''),
    folder: overrides.id.includes('/') ? overrides.id.split('/').slice(0, -1).join('/') : '',
    linksTo: [],
    linkedFrom: [],
    changed: false,
    headingCount: 0,
    wordCount: 0,
    ...overrides
  }
}

describe('buildBrainRows', () => {
  it('groups documents under folder headers in path order', () => {
    const rows = buildBrainRows([doc({ id: 'rules/b.md' }), doc({ id: 'a.md' })])

    expect(rows.map((r) => r.key)).toEqual([
      'folder:',
      'doc:a.md',
      'folder:rules',
      'doc:rules/b.md'
    ])
  })

  it('labels the repo root rather than rendering a blank header', () => {
    const rows = buildBrainRows([doc({ id: 'a.md' })])

    expect(rows[0]).toMatchObject({ kind: 'folder', label: 'Root', documentCount: 1 })
  })

  it('sorts documents by name within a folder', () => {
    const rows = buildBrainRows([doc({ id: 'k/zebra.md' }), doc({ id: 'k/apple.md' })])

    expect(rows.filter((r) => r.kind === 'document').map((r) => r.key)).toEqual([
      'doc:k/apple.md',
      'doc:k/zebra.md'
    ])
  })
})

describe('filterDocuments', () => {
  it('returns everything for a blank query', () => {
    const docs = [doc({ id: 'a.md' })]
    expect(filterDocuments(docs, '   ')).toEqual(docs)
  })

  it('matches on name or folder, case-insensitively', () => {
    const docs = [doc({ id: 'rules/operating.md' }), doc({ id: 'method.md' })]

    expect(filterDocuments(docs, 'RULES').map((d) => d.id)).toEqual(['rules/operating.md'])
    expect(filterDocuments(docs, 'meth').map((d) => d.id)).toEqual(['method.md'])
  })
})

describe('summarizeScan', () => {
  it('counts documents, links, changed docs, and orphans', () => {
    const scan: BrainScan = {
      repoPath: '/repo',
      documents: [doc({ id: 'a.md', changed: true, linksTo: ['b.md'] }), doc({ id: 'b.md' })],
      folders: [{ path: '', documentCount: 2 }],
      orphanIds: ['b.md'],
      totalLinks: 1,
      scannedAt: 0
    }

    expect(summarizeScan(scan)).toEqual({
      documentCount: 2,
      linkCount: 1,
      changedCount: 1,
      orphanCount: 1
    })
  })
})
