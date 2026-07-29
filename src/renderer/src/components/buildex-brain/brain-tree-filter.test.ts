import { describe, expect, it } from 'vitest'
import type { BrainDocument, BrainNode } from '../../../../shared/buildex-brain-types'
import { filterBrainTree } from './brain-tree-filter'

function doc(id: string): BrainDocument {
  return {
    id,
    name: id.split('/').at(-1)?.replace(/\.md$/, '') ?? id,
    title: id.split('/').at(-1)?.replace(/\.md$/i, '') ?? id,
    folder: id.slice(0, id.lastIndexOf('/')),
    linksTo: [],
    linkedFrom: [],
    changed: false,
    headingCount: 0,
    wordCount: 0
  }
}

function node(partial: Partial<BrainNode> & Pick<BrainNode, 'path' | 'title' | 'kind'>): BrainNode {
  return {
    documents: [],
    attachments: [],
    children: [],
    documentCount: 0,
    entityCount: 0,
    changed: false,
    ...partial
  }
}

const acme = node({
  path: 'clients/acme',
  title: 'Acme Corp',
  kind: 'entity',
  main: { documentId: 'clients/acme/index.md', summary: 'Renewal is Q3.' },
  documents: [doc('clients/acme/pricing.md')],
  documentCount: 2,
  entityCount: 1
})

const globex = node({
  path: 'clients/globex',
  title: 'Globex',
  kind: 'entity',
  main: { documentId: 'clients/globex/index.md', summary: 'Paused until spring.' },
  documentCount: 1,
  entityCount: 1
})

const tree: BrainNode[] = [
  node({
    path: 'strategy',
    title: 'Strategy',
    kind: 'section',
    documents: [doc('strategy/overview.md'), doc('strategy/pricing.md')],
    documentCount: 2
  }),
  node({
    path: 'clients',
    title: 'Clients',
    kind: 'section',
    children: [acme, globex],
    documentCount: 3,
    entityCount: 2
  })
]

describe('filterBrainTree', () => {
  it('returns the tree untouched for an empty query', () => {
    expect(filterBrainTree(tree, '   ')).toBe(tree)
  })

  it('drops a section with nothing matching rather than rendering it empty', () => {
    const filtered = filterBrainTree(tree, 'acme')

    expect(filtered.map((entry) => entry.path)).toEqual(['clients'])
    expect(filtered[0]?.children.map((entry) => entry.path)).toEqual(['clients/acme'])
  })

  it('keeps everything under an entity whose own name matched', () => {
    // Having found Acme, you want Acme — not only the files that repeat its name.
    const filtered = filterBrainTree(tree, 'acme')

    expect(filtered[0]?.children[0]?.documents.map((entry) => entry.id)).toEqual([
      'clients/acme/pricing.md'
    ])
  })

  it('matches an entity on its summary', () => {
    const filtered = filterBrainTree(tree, 'spring')

    expect(filtered[0]?.children.map((entry) => entry.path)).toEqual(['clients/globex'])
  })

  it('matches documents by name and keeps only those', () => {
    const filtered = filterBrainTree(tree, 'overview')

    expect(filtered.map((entry) => entry.path)).toEqual(['strategy'])
    expect(filtered[0]?.documents.map((entry) => entry.id)).toEqual(['strategy/overview.md'])
  })

  it('recounts what survived, so a header never claims more than it shows', () => {
    const filtered = filterBrainTree(tree, 'overview')

    expect(filtered[0]?.documentCount).toBe(1)
  })

  it('is case-insensitive', () => {
    expect(filterBrainTree(tree, 'ACME')).toEqual(filterBrainTree(tree, 'acme'))
  })

  it('returns nothing when nothing matches', () => {
    expect(filterBrainTree(tree, 'zzzz')).toEqual([])
  })
})
