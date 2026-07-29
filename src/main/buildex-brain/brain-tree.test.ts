import { describe, expect, it } from 'vitest'
import type { BrainAttachment, BrainDocument, BrainNode } from '../../shared/buildex-brain-types'
import { buildBrainTree } from './brain-tree'

function doc(id: string, extra: Partial<BrainDocument> = {}): BrainDocument {
  return {
    id,
    name: id.split('/').at(-1)?.replace(/\.md$/i, '') ?? id,
    title: id.split('/').at(-1)?.replace(/\.md$/i, '') ?? id,
    folder: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
    linksTo: [],
    linkedFrom: [],
    changed: false,
    headingCount: 0,
    wordCount: 0,
    ...extra
  }
}

function file(id: string, sizeBytes = 10): BrainAttachment {
  return { id, name: id.split('/').at(-1) ?? id, sizeBytes }
}

/** The declared sections the real scaffold provides, trimmed to what tests need. */
const SECTIONS = [
  { folder: 'strategy', title: 'Strategy', purpose: 'What this company is for.' },
  { folder: 'clients', title: 'Clients', purpose: 'Who we work with.' }
]

function build(
  documents: BrainDocument[],
  options: { attachments?: BrainAttachment[]; texts?: Record<string, string> } = {}
): BrainNode[] {
  return buildBrainTree({
    documents,
    attachments: options.attachments ?? [],
    sections: SECTIONS,
    readText: (id) => options.texts?.[id] ?? ''
  })
}

function find(nodes: BrainNode[], path: string): BrainNode {
  for (const node of nodes) {
    if (node.path === path) {
      return node
    }
    const nested = node.children.length ? findOrNull(node.children, path) : null
    if (nested) {
      return nested
    }
  }
  throw new Error(`no node at ${path}`)
}

function findOrNull(nodes: BrainNode[], path: string): BrainNode | null {
  for (const node of nodes) {
    if (node.path === path) {
      return node
    }
    const nested = findOrNull(node.children, path)
    if (nested) {
      return nested
    }
  }
  return null
}

describe('the main file that marks an entity', () => {
  it('recognises index.md', () => {
    const tree = build([doc('clients/acme/index.md'), doc('clients/acme/notes.md')])

    expect(find(tree, 'clients/acme').kind).toBe('entity')
    expect(find(tree, 'clients/acme').main?.documentId).toBe('clients/acme/index.md')
  })

  it('recognises README.md and a file named after the folder', () => {
    const tree = build([doc('clients/globex/README.md'), doc('clients/initech/initech.md')])

    expect(find(tree, 'clients/globex').kind).toBe('entity')
    expect(find(tree, 'clients/initech').kind).toBe('entity')
    expect(find(tree, 'clients/initech').main?.documentId).toBe('clients/initech/initech.md')
  })

  it('does not care about case', () => {
    const tree = build([doc('clients/acme/Index.md'), doc('clients/globex/ReadMe.md')])

    expect(find(tree, 'clients/acme').kind).toBe('entity')
    expect(find(tree, 'clients/globex').kind).toBe('entity')
  })

  it('prefers index.md over the other two, so the choice is never order-dependent', () => {
    const tree = build([
      doc('clients/acme/README.md'),
      doc('clients/acme/acme.md'),
      doc('clients/acme/index.md')
    ])

    expect(find(tree, 'clients/acme').main?.documentId).toBe('clients/acme/index.md')
  })

  it('leaves a folder with no main file a subsection', () => {
    const tree = build([doc('product/pricing/tiers.md'), doc('product/pricing/discounts.md')])

    expect(find(tree, 'product/pricing').kind).toBe('subsection')
    expect(find(tree, 'product/pricing').main).toBeUndefined()
  })

  it('keeps a top-level folder a section even when it holds an index.md', () => {
    // The depth rule. Without it a company that wrote `clients/index.md` as an
    // overview would find Clients rendered as a single client.
    const tree = build([doc('clients/index.md'), doc('clients/acme/index.md')])

    expect(find(tree, 'clients').kind).toBe('section')
    expect(find(tree, 'clients').main).toBeUndefined()
    expect(find(tree, 'clients/acme').kind).toBe('entity')
  })

  it('finds an entity nested under a subsection', () => {
    const tree = build([doc('clients/enterprise/acme/index.md')])

    expect(find(tree, 'clients/enterprise').kind).toBe('subsection')
    expect(find(tree, 'clients/enterprise/acme').kind).toBe('entity')
  })

  it('treats a folder inside an entity as a subsection of it', () => {
    const tree = build([doc('clients/acme/index.md'), doc('clients/acme/calls/2026-03-11.md')])

    expect(find(tree, 'clients/acme/calls').kind).toBe('subsection')
    expect(find(tree, 'clients/acme').children.map((child) => child.path)).toEqual([
      'clients/acme/calls'
    ])
  })
})

describe('titles', () => {
  it('takes an entity title from the main file H1', () => {
    const tree = build([doc('clients/acme/index.md')], {
      texts: { 'clients/acme/index.md': '# Acme Corporation\n\nRenewal is Q3.\n' }
    })

    expect(find(tree, 'clients/acme').title).toBe('Acme Corporation')
  })

  it('humanises the folder name when the main file has no heading', () => {
    const tree = build([doc('clients/acme-corp/index.md')], {
      texts: { 'clients/acme-corp/index.md': 'Renewal is Q3.\n' }
    })

    expect(find(tree, 'clients/acme-corp').title).toBe('Acme Corp')
  })

  it('uses the declared title for a section and humanises an undeclared one', () => {
    const tree = build([doc('strategy/overview.md'), doc('board-minutes/2026-01.md')])

    expect(find(tree, 'strategy').title).toBe('Strategy')
    expect(find(tree, 'board-minutes').title).toBe('Board Minutes')
  })
})

describe('summaries', () => {
  it('takes the first real line of the main file', () => {
    const tree = build([doc('clients/acme/index.md')], {
      texts: {
        'clients/acme/index.md': '# Acme\n\nRenewal is Q3. Champion left in Feb.\n\nMore below.\n'
      }
    })

    expect(find(tree, 'clients/acme').main?.summary).toBe('Renewal is Q3. Champion left in Feb.')
  })

  it('skips the HTML comment every scaffold seed opens with', () => {
    // Without this, a freshly seeded entity summarises itself as the instruction
    // written for the person filling it in.
    const tree = build([doc('clients/acme/index.md')], {
      texts: {
        'clients/acme/index.md':
          '# Acme\n\n<!-- One paragraph a stranger would understand. -->\n\nThey resell in EMEA.\n'
      }
    })

    expect(find(tree, 'clients/acme').main?.summary).toBe('They resell in EMEA.')
  })

  it('is empty when the main file says nothing yet', () => {
    const tree = build([doc('clients/acme/index.md')], {
      texts: { 'clients/acme/index.md': '# Acme\n\n<!-- nothing here yet -->\n' }
    })

    expect(find(tree, 'clients/acme').main?.summary).toBe('')
  })

  it('truncates a long line at a word boundary', () => {
    const long = `${'word '.repeat(60).trim()}.`
    const tree = build([doc('clients/acme/index.md')], {
      texts: { 'clients/acme/index.md': `${long}\n` }
    })

    const summary = find(tree, 'clients/acme').main?.summary ?? ''
    expect(summary.length).toBeLessThanOrEqual(141)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary).not.toContain('wor…')
  })
})

describe('rollups', () => {
  it('counts every document at or below a node, main files included', () => {
    const tree = build([
      doc('clients/acme/index.md'),
      doc('clients/acme/notes.md'),
      doc('clients/acme/calls/2026-03-11.md'),
      doc('clients/globex/index.md')
    ])

    expect(find(tree, 'clients').documentCount).toBe(4)
    expect(find(tree, 'clients/acme').documentCount).toBe(3)
    expect(find(tree, 'clients/acme/calls').documentCount).toBe(1)
  })

  it('counts entities at or below a node', () => {
    const tree = build([
      doc('clients/acme/index.md'),
      doc('clients/globex/index.md'),
      doc('clients/enterprise/initech/index.md'),
      doc('strategy/overview.md')
    ])

    expect(find(tree, 'clients').entityCount).toBe(3)
    expect(find(tree, 'strategy').entityCount).toBe(0)
  })

  it('propagates changed up from a nested file', () => {
    const tree = build([
      doc('clients/acme/index.md'),
      doc('clients/acme/calls/2026-03-11.md', { changed: true }),
      doc('clients/globex/index.md')
    ])

    expect(find(tree, 'clients').changed).toBe(true)
    expect(find(tree, 'clients/acme').changed).toBe(true)
    expect(find(tree, 'clients/globex').changed).toBe(false)
  })
})

describe('attachments', () => {
  it('lands them on their folder and never in documents', () => {
    const tree = build([doc('clients/acme/index.md')], {
      attachments: [file('clients/acme/contract-2026.pdf', 4096)]
    })

    const acme = find(tree, 'clients/acme')
    expect(acme.attachments).toEqual([
      { id: 'clients/acme/contract-2026.pdf', name: 'contract-2026.pdf', sizeBytes: 4096 }
    ])
    expect(acme.documents.map((entry) => entry.id)).toEqual([])
  })

  it('brings a folder into the tree even when it holds no markdown at all', () => {
    const tree = build([doc('clients/acme/index.md')], {
      attachments: [file('clients/acme/scans/signed.pdf')]
    })

    expect(find(tree, 'clients/acme/scans').attachments).toHaveLength(1)
    expect(find(tree, 'clients/acme/scans').documentCount).toBe(0)
  })
})

describe('the shape of the top level', () => {
  it('puts declared sections in declared order, then the rest alphabetically', () => {
    const tree = build([
      doc('zebra/note.md'),
      doc('clients/acme/index.md'),
      doc('applications/note.md'),
      doc('strategy/overview.md')
    ])

    expect(tree.map((node) => node.path)).toEqual(['strategy', 'clients', 'applications', 'zebra'])
  })

  it('declares a section that exists only in the scaffold, so an empty one still shows', () => {
    const tree = build([doc('clients/acme/index.md')])

    expect(tree.map((node) => node.path)).toEqual(['strategy', 'clients'])
    expect(find(tree, 'strategy').documentCount).toBe(0)
  })

  it('puts root documents last, and only when there are some', () => {
    expect(build([doc('strategy/overview.md')]).some((node) => node.path === '')).toBe(false)

    const tree = build([doc('strategy/overview.md'), doc('charter.md')])
    expect(tree.at(-1)?.path).toBe('')
    expect(tree.at(-1)?.documents.map((entry) => entry.id)).toEqual(['charter.md'])
  })

  it('excludes the main file from its own folder documents', () => {
    const tree = build([doc('clients/acme/index.md'), doc('clients/acme/notes.md')])

    expect(find(tree, 'clients/acme').documents.map((entry) => entry.id)).toEqual([
      'clients/acme/notes.md'
    ])
  })
})

describe('determinism', () => {
  it('builds an identical tree from the same input twice', () => {
    const documents = [
      doc('clients/globex/index.md'),
      doc('clients/acme/index.md'),
      doc('clients/acme/notes.md'),
      doc('strategy/overview.md')
    ]
    const attachments = [file('clients/acme/contract.pdf')]
    const texts = { 'clients/acme/index.md': '# Acme\n\nRenewal is Q3.\n' }

    expect(build(documents, { attachments, texts })).toEqual(
      build(documents.toReversed(), { attachments, texts })
    )
  })
})
