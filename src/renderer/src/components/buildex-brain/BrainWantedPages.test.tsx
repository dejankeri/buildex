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
        pages={[{ name: 'acme-renewal-terms', requestedBy: ['clients/acme.md'] }]}
        onOpenDocument={onOpenDocument}
      />
    )

    expect(screen.getByText('acme-renewal-terms')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'clients/acme.md' }))

    expect(onOpenDocument).toHaveBeenCalledWith('clients/acme.md')
  })

  it('renders nothing when the brain is asking for nothing', () => {
    const { container } = render(<BrainWantedPages pages={[]} onOpenDocument={vi.fn()} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('stays a short list however long the backlog gets', () => {
    render(
      <BrainWantedPages
        pages={Array.from({ length: 30 }, (_, index) => ({
          name: `wanted-${index}`,
          requestedBy: ['a.md']
        }))}
        onOpenDocument={vi.fn()}
      />
    )

    expect(screen.getAllByText(/^wanted-\d+$/)).toHaveLength(12)
    expect(screen.getByText('+18 more wanted')).toBeInTheDocument()
  })
})
