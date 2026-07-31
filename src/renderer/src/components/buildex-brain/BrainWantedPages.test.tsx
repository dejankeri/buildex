// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrainWantedPages from './BrainWantedPages'

afterEach(() => {
  cleanup()
})

describe('BrainWantedPages', () => {
  it('names the page and the document that asked for it', async () => {
    const onOpenDocument = vi.fn()
    render(
      <BrainWantedPages
        pages={[
          { name: 'acme-renewal-terms', requestedBy: ['clients/acme.md'], requestedByCount: 1 }
        ]}
        totalCount={1}
        onOpenDocument={onOpenDocument}
      />
    )

    expect(screen.getByText('acme-renewal-terms')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'clients/acme.md' }))

    expect(onOpenDocument).toHaveBeenCalledWith('clients/acme.md')
  })

  it('renders nothing when the brain is asking for nothing', () => {
    const { container } = render(
      <BrainWantedPages pages={[]} totalCount={0} onOpenDocument={vi.fn()} />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('stays a short list however long the backlog gets', () => {
    render(
      <BrainWantedPages
        pages={Array.from({ length: 30 }, (_, index) => ({
          name: `wanted-${index}`,
          requestedBy: ['a.md'],
          requestedByCount: 1
        }))}
        totalCount={30}
        onOpenDocument={vi.fn()}
      />
    )

    expect(screen.getAllByText(/^wanted-\d+$/)).toHaveLength(12)
    expect(screen.getByText('+18 more wanted')).toBeInTheDocument()
  })

  it('counts from the total, not from the prefix the scan sent it', () => {
    // The scan caps `wantedPages` at 50 before this ever sees it, so counting
    // the array would report "+38 more" for a brain that wants 200 pages.
    render(
      <BrainWantedPages
        pages={Array.from({ length: 50 }, (_, index) => ({
          name: `wanted-${index}`,
          requestedBy: ['a.md'],
          requestedByCount: 1
        }))}
        totalCount={200}
        onOpenDocument={vi.fn()}
      />
    )

    expect(screen.getByText('200')).toBeInTheDocument()
    expect(screen.getByText('+188 more wanted')).toBeInTheDocument()
  })

  it('reports every asker a page has, not just the ones it was sent', () => {
    render(
      <BrainWantedPages
        pages={[
          {
            name: 'escalation',
            requestedBy: ['a.md', 'b.md', 'c.md', 'd.md'],
            requestedByCount: 40
          }
        ]}
        totalCount={1}
        onOpenDocument={vi.fn()}
      />
    )

    expect(screen.getByText('+37 more')).toBeInTheDocument()
  })
})
