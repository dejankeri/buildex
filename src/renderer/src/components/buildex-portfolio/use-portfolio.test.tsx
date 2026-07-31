// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_BRAIN_SCAN } from '../../../../shared/buildex-brain-types'
import { EMPTY_STORE_CATALOG } from '../../../../shared/buildex-store-types'
import type { Repo } from '../../../../shared/types'
import { usePortfolio, type PortfolioState } from './use-portfolio'

// Which repos are businesses, and what a business looks like when this machine
// cannot read it. Both answers write to other people's repos if they are wrong:
// scanning is what puts the gate and the company context in a checkout, so a
// dashboard that scans every repo in the sidebar gates all of them.

const repos: Repo[] = [
  { id: 'local', path: '/repos/acme', displayName: 'Acme', badgeColor: '#111', addedAt: 0 },
  { id: 'plain', path: '/repos/plain', displayName: 'Plain', badgeColor: '#222', addedAt: 0 },
  {
    id: 'remote',
    path: '/home/ubuntu/beta',
    displayName: 'Beta',
    badgeColor: '#333',
    addedAt: 0,
    connectionId: 'ssh-1'
  }
]

const storeState = {
  repos,
  worktreesByRepo: {
    local: [{ id: 'local::/repos/acme', isMainWorktree: true, path: '/repos/acme' }]
  }
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

const readDir = vi.fn()
const resolve = vi.fn()
const scan = vi.fn()
const catalog = vi.fn()

let latest: PortfolioState | null = null
let root: Root | null = null
let host: HTMLDivElement | null = null

function Probe(): null {
  latest = usePortfolio()
  return null
}

async function renderProbe(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host!)
    root.render(<Probe />)
  })
  // The sweep fills rows one business at a time after the first paint.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  readDir.mockReset()
  resolve.mockReset()
  scan.mockReset()
  catalog.mockReset()
  latest = null
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      fs: { readDir },
      buildexBrain: { resolve, scan },
      buildexStore: { catalog },
      buildexBrainSections: { list: async () => ({ sections: [] }) },
      automations: { list: async () => [], listRuns: async () => [] }
    }
  })
  resolve.mockImplementation(async ({ repoPath }: { repoPath: string }) => ({
    status: 'ready',
    location: {
      root: `${repoPath}/.buildex`,
      gitRoot: repoPath,
      pathspec: '.buildex',
      mode: 'embedded'
    }
  }))
  scan.mockResolvedValue({ ...EMPTY_BRAIN_SCAN, initialized: true })
  catalog.mockResolvedValue(EMPTY_STORE_CATALOG)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('usePortfolio', () => {
  it('leaves a repo with no brain out, and never scans it', async () => {
    readDir.mockImplementation(async ({ dirPath }: { dirPath: string }) =>
      dirPath.startsWith('/repos/acme')
        ? [{ name: 'strategy' }]
        : Promise.reject(new Error('ENOENT: no such file or directory'))
    )

    await renderProbe()

    expect(latest?.companies.map((entry) => entry.repoId)).toEqual(['local'])
    // The gate, the skill links and the company context all land on scan. A
    // repo the operator never made a business must not receive them.
    expect(scan).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledWith({ repoPath: '/repos/acme' })
  })

  it('lists an SSH business as degraded and asks the brain IPC nothing about it', async () => {
    readDir.mockImplementation(async ({ dirPath }: { dirPath: string }) =>
      dirPath.includes('beta') || dirPath.startsWith('/repos/acme')
        ? [{ name: 'strategy' }]
        : Promise.reject(new Error('ENOENT'))
    )

    await renderProbe()

    const beta = latest?.companies.find((entry) => entry.repoId === 'remote')
    expect(beta?.degraded).toBe('remote-host')
    // A path cannot say which machine it names; resolving it here would answer
    // about a local directory that merely shares the path.
    expect(resolve).not.toHaveBeenCalledWith({ repoPath: '/home/ubuntu/beta' })
    expect(readDir).toHaveBeenCalledWith({
      dirPath: '/home/ubuntu/beta/.buildex',
      connectionId: 'ssh-1'
    })
  })

  it('keeps a business whose scan fails, degraded, without losing the others', async () => {
    readDir.mockResolvedValue([{ name: 'strategy' }])
    scan.mockImplementation(async ({ repoPath }: { repoPath: string }) => {
      if (repoPath === '/repos/acme') {
        throw new Error('git is wedged')
      }
      return { ...EMPTY_BRAIN_SCAN, initialized: true }
    })

    await renderProbe()

    expect(latest?.companies.find((entry) => entry.repoId === 'local')?.degraded).toBe('unreadable')
    expect(latest?.companies.find((entry) => entry.repoId === 'plain')?.degraded).toBeNull()
  })
})
