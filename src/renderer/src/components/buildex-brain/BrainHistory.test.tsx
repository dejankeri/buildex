// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BrainHistory from './BrainHistory'

// The promise this covers: an operator who saves offline keeps their writing
// and is told the team does not have it yet. Silence there reads as "shared".

const save = vi.fn()
const push = vi.fn()

const HISTORY = {
  saves: [],
  unavailable: false,
  unsavedPaths: ['decisions/pricing.md']
}

beforeEach(() => {
  save.mockReset()
  push.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = {
    buildexBrain: { push },
    buildexBrainSections: { save }
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function saveWith(result: unknown): Promise<void> {
  save.mockResolvedValue(result)
  render(
    <BrainHistory history={HISTORY} repoPath="/repo" onSaved={vi.fn()} onOpenDocument={vi.fn()} />
  )
  await userEvent.type(screen.getByRole('textbox'), 'Q3 pricing')
  await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
}

describe('BrainHistory saving', () => {
  it('says a save that never reached the brain repo is not shared yet', async () => {
    await saveWith({
      ok: true,
      savedPaths: ['decisions/pricing.md'],
      pushed: false,
      pushError: 'could not resolve host github.com'
    })

    await waitFor(() => expect(screen.getByText(/not shared yet/i)).toBeInTheDocument())
    expect(screen.getByText(/could not resolve host/i)).toBeInTheDocument()
  })

  it('shares again on retry, and stops saying so once it lands', async () => {
    await saveWith({ ok: true, savedPaths: [], pushed: false, pushError: 'offline' })
    await waitFor(() => expect(screen.getByText(/not shared yet/i)).toBeInTheDocument())
    push.mockResolvedValue({ pushed: true })

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(push).toHaveBeenCalledWith({ repoPath: '/repo' })
    await waitFor(() => expect(screen.queryByText(/not shared yet/i)).not.toBeInTheDocument())
  })

  it('says nothing about sharing in embedded mode, where BuildEx never pushes', async () => {
    await saveWith({ ok: true, savedPaths: ['decisions/pricing.md'] })

    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(screen.queryByText(/not shared yet/i)).not.toBeInTheDocument()
  })
})
