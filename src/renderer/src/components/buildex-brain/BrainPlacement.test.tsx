// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import BrainPlacement from './BrainPlacement'

describe('BrainPlacement', () => {
  it('offers to clone the brain a repo points at', () => {
    render(
      <BrainPlacement
        resolution={{
          status: 'needs-clone',
          remote: 'git@github.com:acme/brain.git',
          suggestedPath: '/home/dev/.buildex/brains/brain'
        }}
        onClone={vi.fn()}
        onDisconnect={vi.fn()}
      />
    )

    expect(screen.getByText(/acme\/brain/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /clone/i })).toBeInTheDocument()
  })

  it('says plainly when the brain folder has gone', () => {
    render(
      <BrainPlacement
        resolution={{ status: 'broken', reason: 'missing', path: '/brains/acme' }}
        onClone={vi.fn()}
        onDisconnect={vi.fn()}
      />
    )

    expect(screen.getByText(/\/brains\/acme/)).toBeInTheDocument()
  })

  it('renders nothing at all when the brain resolved fine', () => {
    const { container } = render(
      <BrainPlacement
        resolution={{
          status: 'ready',
          location: { root: '/x', gitRoot: '/x', pathspec: '.', mode: 'external' }
        }}
        onClone={vi.fn()}
        onDisconnect={vi.fn()}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })
})
