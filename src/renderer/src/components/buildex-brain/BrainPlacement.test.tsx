// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BrainPlacement from './BrainPlacement'

afterEach(() => {
  cleanup()
})

describe('BrainPlacement', () => {
  it('says why a clone failed instead of re-rendering the same screen', async () => {
    render(
      <BrainPlacement
        resolution={{
          status: 'needs-clone',
          remote: 'git@github.com:acme/brain.git',
          suggestedPath: '/home/dev/.buildex/brains/brain'
        }}
        onClone={vi.fn().mockRejectedValue(new Error('Permission denied (publickey)'))}
        onDisconnect={vi.fn()}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /clone/i }))

    await waitFor(() =>
      expect(screen.getByText(/permission denied \(publickey\)/i)).toBeInTheDocument()
    )
  })

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
