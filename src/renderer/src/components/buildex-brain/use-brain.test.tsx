// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_BRAIN_SCAN } from '../../../../shared/buildex-brain-types'
import { useBrain, type BrainState } from './use-brain'

// The seam the pristine-repo bug lived in: `setUp` deciding, for an external
// placement, whether to `migrate` an embedded brain's files or `bind` a repo
// that has none. A DOM click-through can only prove the button was pressed;
// this proves the decision itself — migrate when there is something embedded
// to move, bind when there is not, and never silently falling back to an
// embedded brain when neither call succeeds.

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ path: '/repo' })
}))

const scan = vi.fn()
const setUp = vi.fn()
const migrate = vi.fn()
const bind = vi.fn()
const historyList = vi.fn()
const sectionsList = vi.fn()
const pull = vi.fn()
const clone = vi.fn()

let latestState: BrainState | null = null
let root: Root | null = null
let host: HTMLDivElement | null = null

function HookProbe(): null {
  latestState = useBrain()
  return null
}

async function renderProbe(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<HookProbe />)
  })
}

function state(): BrainState {
  if (!latestState) {
    throw new Error('useBrain has not rendered yet')
  }
  return latestState
}

const externalPlacement = {
  mode: 'external' as const,
  brainPath: '/brains/acme',
  writePointer: false
}

beforeEach(() => {
  scan.mockReset()
  setUp.mockReset().mockResolvedValue({ ok: true, created: [] })
  migrate.mockReset()
  bind.mockReset()
  historyList.mockReset().mockResolvedValue({ saves: [], unavailable: true, unsavedPaths: [] })
  pull.mockReset().mockResolvedValue({ pulled: false, diverged: false })
  clone.mockReset()
  sectionsList.mockReset().mockResolvedValue({ sections: [] })
  latestState = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = {
    buildexBrain: { scan, setUp, migrate, bind, pull, clone },
    buildexBrainSections: { list: sectionsList, history: historyList }
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

const EXTERNAL_SCAN = {
  ...EMPTY_BRAIN_SCAN,
  repoPath: '/repo',
  initialized: true,
  resolution: {
    status: 'ready' as const,
    location: {
      root: '/brains/acme',
      gitRoot: '/brains/acme',
      pathspec: '.',
      mode: 'external' as const
    }
  }
}

describe('useBrain opening a shared brain', () => {
  it('reports a brain that has diverged rather than merging it', async () => {
    scan.mockResolvedValue(EXTERNAL_SCAN)
    pull.mockResolvedValue({ pulled: false, diverged: true })
    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    expect(pull).toHaveBeenCalledWith({ repoPath: '/repo' })
    expect(state().diverged).toBe(true)
  })

  it('never fetches for an embedded brain, whose git root is the code repo', async () => {
    scan.mockResolvedValue({
      ...EMPTY_BRAIN_SCAN,
      repoPath: '/repo',
      initialized: true,
      resolution: {
        status: 'ready' as const,
        location: {
          root: '/repo/.buildex',
          gitRoot: '/repo',
          pathspec: '.buildex',
          mode: 'embedded' as const
        }
      }
    })
    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    expect(pull).not.toHaveBeenCalled()
    expect(state().diverged).toBe(false)
  })
})

describe('useBrain cloneBrain', () => {
  it('raises a failed clone rather than swallowing it', async () => {
    scan.mockResolvedValue({
      ...EMPTY_BRAIN_SCAN,
      repoPath: '/repo',
      resolution: {
        status: 'needs-clone' as const,
        remote: 'git@github.com:acme/brain.git',
        suggestedPath: '/brains/brain'
      }
    })
    clone.mockResolvedValue({ ok: false, error: 'Permission denied (publickey)' })
    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    await expect(
      act(async () => {
        await state().cloneBrain('/brains/brain')
      })
    ).rejects.toThrow('Permission denied (publickey)')
  })
})

describe('useBrain setUp — migrate vs bind', () => {
  it('binds, never migrates, when there is no embedded brain to move', async () => {
    scan.mockResolvedValue({ ...EMPTY_BRAIN_SCAN, repoPath: '/repo', embeddedBrainPresent: false })
    bind.mockResolvedValue({ ok: true })
    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await state().setUp(['strategy'], '', externalPlacement)
    })

    expect(bind).toHaveBeenCalledWith({
      repoPath: '/repo',
      brainPath: '/brains/acme',
      writePointer: false
    })
    expect(migrate).not.toHaveBeenCalled()
    expect(setUp).toHaveBeenCalledWith({ repoPath: '/repo', folders: ['strategy'], summary: '' })
  })

  it('migrates, never binds, when an embedded brain is there to move', async () => {
    scan.mockResolvedValue({ ...EMPTY_BRAIN_SCAN, repoPath: '/repo', embeddedBrainPresent: true })
    migrate.mockResolvedValue({ ok: true, movedPaths: [] })
    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await state().setUp(['strategy'], '', externalPlacement)
    })

    expect(migrate).toHaveBeenCalledWith({
      repoPath: '/repo',
      brainPath: '/brains/acme',
      writePointer: false
    })
    expect(bind).not.toHaveBeenCalled()
    expect(setUp).toHaveBeenCalledWith({ repoPath: '/repo', folders: ['strategy'], summary: '' })
  })

  it('never scaffolds embedded when the pristine-repo bind fails — it surfaces the error instead', async () => {
    scan.mockResolvedValue({ ...EMPTY_BRAIN_SCAN, repoPath: '/repo', embeddedBrainPresent: false })
    bind.mockResolvedValue({ ok: false, error: 'acme/brain.git is not reachable' })
    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    await expect(
      act(async () => {
        await state().setUp(['strategy'], '', externalPlacement)
      })
    ).rejects.toThrow('acme/brain.git is not reachable')

    // The one outcome that must never happen again: sections landing embedded
    // because the external connect silently failed.
    expect(setUp).not.toHaveBeenCalled()
  })

  it('sends an embedded placement straight to setUp, calling neither migrate nor bind', async () => {
    scan.mockResolvedValue({ ...EMPTY_BRAIN_SCAN, repoPath: '/repo', embeddedBrainPresent: false })
    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      await state().setUp(['strategy'], '', { mode: 'embedded' })
    })

    expect(migrate).not.toHaveBeenCalled()
    expect(bind).not.toHaveBeenCalled()
    expect(setUp).toHaveBeenCalledWith({ repoPath: '/repo', folders: ['strategy'], summary: '' })
  })
})
