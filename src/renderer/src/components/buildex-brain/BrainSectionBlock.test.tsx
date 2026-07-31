// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrainDocument } from '../../../../shared/buildex-brain-types'
import { BrainDocumentRow } from './BrainSectionBlock'

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
