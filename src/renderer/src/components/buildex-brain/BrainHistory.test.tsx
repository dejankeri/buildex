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
const saveDiff = vi.fn()

const HISTORY = {
  saves: [],
  unavailable: false,
  unsavedPaths: ['decisions/pricing.md']
}

const SAVED = {
  saves: [
    {
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      subject: 'Overnight run',
      author: 'agent',
      timestamp: Math.floor(Date.now() / 1000) - 3600,
      changedPaths: ['decisions/log.md']
    }
  ],
  unavailable: false,
  unsavedPaths: []
}

beforeEach(() => {
  save.mockReset()
  push.mockReset()
  saveDiff.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = {
    buildexBrain: { push },
    buildexBrainSections: { save, saveDiff }
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
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    expect(screen.queryByText(/no remote yet/i)).not.toBeInTheDocument()
  })

  it('shares again on retry, and stops saying so once it lands', async () => {
    await saveWith({ ok: true, savedPaths: [], pushed: false, pushError: 'offline' })
    await waitFor(() => expect(screen.getByText(/not shared yet/i)).toBeInTheDocument())
    push.mockResolvedValue({ pushed: true })

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(push).toHaveBeenCalledWith({ repoPath: '/repo' })
    await waitFor(() => expect(screen.queryByText(/not shared yet/i)).not.toBeInTheDocument())
  })

  it('calls a brain with no remote local-only, with no warning and no retry', async () => {
    await saveWith({
      ok: true,
      savedPaths: ['decisions/pricing.md'],
      pushed: false,
      localOnly: true
    })

    await waitFor(() => expect(screen.getByText(/no remote yet/i)).toBeInTheDocument())
    // Nothing failed, and pressing a retry could only fail the same way forever.
    expect(screen.queryByText(/not shared yet/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
  })

  it('says nothing about sharing in embedded mode, where BuildEx never pushes', async () => {
    await saveWith({ ok: true, savedPaths: ['decisions/pricing.md'] })

    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(screen.queryByText(/not shared yet/i)).not.toBeInTheDocument()
  })
})

// The review question a scheduled run leaves behind is "what did that night
// add?", and today's version of the document cannot answer it.
describe('opening a save', () => {
  async function open(diff: unknown): Promise<void> {
    saveDiff.mockResolvedValue(diff)
    render(
      <BrainHistory history={SAVED} repoPath="/repo" onSaved={vi.fn()} onOpenDocument={vi.fn()} />
    )
    await userEvent.click(screen.getByRole('button', { name: /overnight run/i }))
  }

  it('shows the lines that save added, asked for by hash', async () => {
    await open({
      files: [
        {
          path: 'decisions/log.md',
          status: 'modified',
          binary: false,
          truncated: false,
          lines: [
            { kind: 'meta', text: '@@ -1,1 +1,3 @@' },
            { kind: 'context', text: '# Decision log' },
            { kind: 'add', text: '## 2026-07-31 — priced the starter tier' }
          ]
        }
      ],
      truncated: false,
      unavailable: false
    })

    expect(saveDiff).toHaveBeenCalledWith({ repoPath: '/repo', hash: 'a'.repeat(40) })
    await waitFor(() => expect(screen.getByText(/priced the starter tier/)).toBeInTheDocument())
  })

  it('names a rename on both sides and shows no invented lines', async () => {
    await open({
      files: [
        {
          path: 'rules/how-we-work.md',
          previousPath: 'rules/operating.md',
          status: 'renamed',
          binary: false,
          truncated: false,
          lines: []
        }
      ],
      truncated: false,
      unavailable: false
    })

    await waitFor(() =>
      expect(screen.getByText('rules/operating.md → rules/how-we-work.md')).toBeInTheDocument()
    )
    expect(screen.getByText('renamed')).toBeInTheDocument()
  })

  it('says a binary file is not text rather than rendering its bytes', async () => {
    await open({
      files: [{ path: 'logo.png', status: 'added', binary: true, truncated: false, lines: [] }],
      truncated: false,
      unavailable: false
    })

    await waitFor(() =>
      expect(screen.getByText(/nothing to show line by line/i)).toBeInTheDocument()
    )
  })

  it('says a save changed nothing here instead of showing a blank panel', async () => {
    await open({ files: [], truncated: false, unavailable: false })

    await waitFor(() =>
      expect(screen.getByText(/changed nothing in the brain/i)).toBeInTheDocument()
    )
  })

  it('closes again on a second click', async () => {
    await open({ files: [], truncated: false, unavailable: false })
    await waitFor(() =>
      expect(screen.getByText(/changed nothing in the brain/i)).toBeInTheDocument()
    )

    await userEvent.click(screen.getByRole('button', { name: /overnight run/i }))

    expect(screen.queryByText(/changed nothing in the brain/i)).not.toBeInTheDocument()
  })

  it('leaves the changed-path links opening the document, not the diff', async () => {
    const onOpenDocument = vi.fn()
    saveDiff.mockResolvedValue({ files: [], truncated: false, unavailable: false })
    render(
      <BrainHistory
        history={SAVED}
        repoPath="/repo"
        onSaved={vi.fn()}
        onOpenDocument={onOpenDocument}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'decisions/log.md' }))

    expect(onOpenDocument).toHaveBeenCalledWith('decisions/log.md')
    expect(saveDiff).not.toHaveBeenCalled()
  })
})
