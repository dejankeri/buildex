// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrainDocument, BrainNode } from '../../../../shared/buildex-brain-types'
import BrainSectionBlock, { BrainDocumentRow } from './BrainSectionBlock'

// A filename is a weak recall key. The description is what makes the tree worth
// scanning — and its absence has to leave the chip exactly as it was.

function doc(id: string, extra: Partial<BrainDocument> = {}): BrainDocument {
  const name = id.split('/').at(-1)?.replace(/\.md$/, '') ?? id
  return {
    id,
    name,
    title: name,
    folder: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
    linksTo: [],
    linkedFrom: [],
    changed: false,
    headingCount: 0,
    wordCount: 0,
    ...extra
  }
}

function node(partial: Partial<BrainNode> & Pick<BrainNode, 'path' | 'title'>): BrainNode {
  return {
    kind: 'subsection',
    documents: [],
    attachments: [],
    children: [],
    documentCount: 0,
    entityCount: 0,
    changed: false,
    ...partial
  }
}

afterEach(() => {
  cleanup()
})

describe('BrainDocumentRow', () => {
  it('shows a document description beside its title', () => {
    render(
      <BrainDocumentRow
        documents={[doc('decisions/pricing.md', { description: 'Why we price per seat.' })]}
        onOpen={vi.fn()}
      />
    )

    expect(screen.getByText('pricing')).toBeInTheDocument()
    expect(screen.getByText('Why we price per seat.')).toBeInTheDocument()
  })

  it('shows the title alone for a document that wrote no description', () => {
    render(<BrainDocumentRow documents={[doc('decisions/plain.md')]} onOpen={vi.fn()} />)

    expect(screen.getByRole('button')).toHaveTextContent(/^plain$/)
  })
})

// A folder with a main file is what the agent-facing render counts as an entity.
// On screen it is a folder, and clicking it opens that file — the app no longer
// has a second kind of thing with a page and a card of its own.
describe('a folder with a main file', () => {
  const acme = node({
    path: 'clients/acme',
    title: 'Acme Corp',
    kind: 'entity',
    main: { documentId: 'clients/acme/index.md', summary: 'Renewal is Q3.' },
    documents: [doc('clients/acme/pricing.md')],
    documentCount: 2,
    entityCount: 1
  })

  it('opens its main file when clicked, and says what it is about', () => {
    const onOpenDocument = vi.fn()
    render(
      <BrainSectionBlock
        node={node({
          path: 'clients',
          title: 'Clients',
          children: [acme],
          documentCount: 2,
          entityCount: 1
        })}
        onOpenDocument={onOpenDocument}
        onOpenAttachment={vi.fn()}
        onAdd={vi.fn()}
      />
    )

    fireEvent.click(screen.getByText('Acme Corp'))

    expect(onOpenDocument).toHaveBeenCalledWith('clients/acme/index.md')
    expect(screen.getByText('Renewal is Q3.')).toBeInTheDocument()
    // The rest of the folder is listed where it sits, not behind a page of its own.
    expect(screen.getByText('pricing')).toBeInTheDocument()
  })

  it('adds a folder into the folder whose Add was clicked, not the section above it', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn()
    render(
      <BrainSectionBlock
        node={node({ path: 'clients', title: 'Clients', children: [acme], documentCount: 2 })}
        onOpenDocument={vi.fn()}
        onOpenAttachment={vi.fn()}
        onAdd={onAdd}
        renderAdding={(folder) => <span key={folder}>adding to {folder}</span>}
      />
    )

    // The second Add is Acme's own; the first belongs to Clients above it.
    await user.click(screen.getAllByRole('button', { name: /Add/ })[1])
    await user.click(screen.getByRole('menuitem', { name: 'New folder' }))

    expect(onAdd).toHaveBeenCalledWith('clients/acme', 'folder')
    expect(screen.getByText('adding to clients/acme')).toBeInTheDocument()
  })
})
