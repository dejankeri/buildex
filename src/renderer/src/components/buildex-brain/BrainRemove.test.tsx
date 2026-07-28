// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainLocation } from '../../../../shared/buildex-brain-types'
import BrainRemove from './BrainRemove'

// External is a different action from embedded: nothing is deleted, so the
// button must call `disconnect`, never `remove` — Task 12 made `remove` refuse
// an external location outright, and a caller that still points at it fails
// closed with an error the operator did not ask for.

const disconnect = vi.fn()
const remove = vi.fn()
const removalPlan = vi.fn()

// DialogContent renders through a Portal into `document.body`, outside the
// host element it was mounted under — queries go against the document.
function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((entry) =>
    entry.textContent?.includes(label)
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

const embeddedLocation: BrainLocation = {
  root: '/repo/.buildex',
  gitRoot: '/repo',
  pathspec: '.buildex',
  mode: 'embedded'
}

const externalLocation: BrainLocation = {
  root: '/brains/acme',
  gitRoot: '/brains/acme',
  pathspec: '.',
  mode: 'external'
}

describe('BrainRemove', () => {
  let root: Root | null = null
  let host: HTMLDivElement | null = null

  beforeEach(() => {
    disconnect.mockReset().mockResolvedValue({ ok: true, committed: false })
    remove.mockReset().mockResolvedValue({ ok: true, committed: false })
    removalPlan
      .mockReset()
      .mockResolvedValue({
        documentCount: 0,
        unsavedPaths: [],
        canCommit: false,
        willBackUp: false
      })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
    ;(window as any).api = {
      buildexBrain: { disconnect, remove, removalPlan }
    }
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    host?.remove()
    host = null
  })

  function renderDialog(location: BrainLocation | null): void {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <BrainRemove
          repoPath="/repo"
          location={location}
          open
          onOpenChange={vi.fn()}
          onRemoved={vi.fn()}
        />
      )
    })
  }

  it('calls disconnect, never remove, when the brain is external', async () => {
    renderDialog(externalLocation)

    expect(document.body.textContent).toContain('Disconnect this repo from the company brain?')
    expect(document.body.textContent).toContain('/brains/acme')

    await act(async () => {
      findButton('Disconnect').click()
      await Promise.resolve()
    })

    expect(disconnect).toHaveBeenCalledWith({ repoPath: '/repo' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('calls remove, never disconnect, when the brain is embedded', async () => {
    renderDialog(embeddedLocation)

    expect(document.body.textContent).toContain('Remove the company brain?')

    await act(async () => {
      findButton('Remove the brain').click()
      await Promise.resolve()
    })

    expect(remove).toHaveBeenCalledWith({ repoPath: '/repo' })
    expect(disconnect).not.toHaveBeenCalled()
  })
})
