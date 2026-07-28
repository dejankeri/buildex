// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_BRAIN_SCAN, type BrainMode } from '../../../../shared/buildex-brain-types'
import type { BrainState } from './use-brain'

// What the header offers, per mode. An external brain is shared by every repo
// bound to it, and this menu is the only place the operator sees what pressing
// the item is about to do.

const state = vi.fn()
vi.mock('./use-brain', () => ({ useBrain: () => state() }))

const { default: BrainPage } = await import('./BrainPage')

function brainState(mode: BrainMode): BrainState {
  const root = mode === 'external' ? '/brains/acme' : '/repo/.buildex'
  return {
    repoPath: '/repo',
    scan: {
      ...EMPTY_BRAIN_SCAN,
      repoPath: '/repo',
      initialized: true,
      resolution: {
        status: 'ready',
        location: {
          root,
          gitRoot: mode === 'external' ? root : '/repo',
          pathspec: mode === 'external' ? '.' : '.buildex',
          mode
        }
      }
    },
    resolution: null,
    sections: [],
    history: { saves: [], unavailable: false, unsavedPaths: [] },
    loading: false,
    diverged: false,
    refresh: vi.fn(),
    openFile: null,
    openDocument: vi.fn(),
    openPath: vi.fn(),
    closeFile: vi.fn(),
    setUp: vi.fn(),
    cloneBrain: vi.fn(),
    disconnect: vi.fn()
  }
}

beforeEach(() => {
  state.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('BrainPage menu', () => {
  it('offers to disconnect, never to remove, when the brain is shared', async () => {
    state.mockReturnValue(brainState('external'))
    render(<BrainPage />)

    await userEvent.click(screen.getByRole('button', { name: /more/i }))

    await waitFor(() => expect(screen.getByText(/disconnect this repo/i)).toBeInTheDocument())
    // Deleting a shared brain is not a BuildEx action, so promising it here is
    // promising the wrong blast radius.
    expect(screen.queryByText(/remove the company brain/i)).not.toBeInTheDocument()
  })

  it('still offers removal for a brain that lives in this repo', async () => {
    state.mockReturnValue(brainState('embedded'))
    render(<BrainPage />)

    await userEvent.click(screen.getByRole('button', { name: /more/i }))

    await waitFor(() => expect(screen.getByText(/remove the company brain/i)).toBeInTheDocument())
  })
})
