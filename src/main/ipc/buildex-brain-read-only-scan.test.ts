import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainScan, BrainScanRequest } from '../../shared/buildex-brain-types'

// A scan normally prepares the checkout on the way past: the gate lands in
// `.claude/settings.json`, the brain's skills are linked into `.claude/skills/`,
// and the company context is rewritten. That is right for a repo somebody just
// opened and wrong for one of N repos a dashboard is summarising — the Portfolio
// would otherwise gate every business on the operator's machine because they
// glanced at a table, and again on every refresh.

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request?: unknown) => unknown>(),
  refreshCompanyContext: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()) },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, request?: unknown) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))

// Mocked rather than observed on disk: it is void-fired, so a filesystem
// assertion would race the handler's own return.
vi.mock('../buildex-brain/company-context-refresh', () => ({
  refreshCompanyContext: mocks.refreshCompanyContext
}))

const { registerBuildExBrainHandlers } = await import('./buildex-brain')
const { resetCompanyRepoInitialization } = await import('../buildex-repo-init')

let repoPath = ''

function readExclude(): string {
  try {
    return readFileSync(path.join(repoPath, '.git', 'info', 'exclude'), 'utf8')
  } catch {
    return ''
  }
}

function scanChannel(): (event: unknown, request?: BrainScanRequest) => Promise<BrainScan> {
  const handler = mocks.handlers.get('buildex-brain:scan')
  if (!handler) {
    throw new Error('buildex-brain:scan was never registered')
  }
  return handler as (event: unknown, request?: BrainScanRequest) => Promise<BrainScan>
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.refreshCompanyContext.mockClear()
  resetCompanyRepoInitialization()
  registerBuildExBrainHandlers()

  repoPath = mkdtempSync(path.join(tmpdir(), 'buildex-readonly-scan-'))
  execFileSync('git', ['init', '--quiet'], { cwd: repoPath })
  mkdirSync(path.join(repoPath, '.buildex', 'strategy'), { recursive: true })
  writeFileSync(path.join(repoPath, '.buildex', 'strategy', 'overview.md'), '# Overview\n', 'utf8')
  mkdirSync(path.join(repoPath, '.buildex', 'skills', 'record-decision'), { recursive: true })
  writeFileSync(
    path.join(repoPath, '.buildex', 'skills', 'record-decision', 'SKILL.md'),
    '# Record a decision\n',
    'utf8'
  )
})

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true })
})

describe('buildex-brain:scan readOnly', () => {
  it('reads the brain and leaves the repo exactly as it found it', async () => {
    const scan = await scanChannel()(null, { repoPath, readOnly: true })

    // The reading itself is unchanged — this is the same scan, minus the writes.
    expect(scan.initialized).toBe(true)
    expect(scan.documents.map((document) => document.id)).toContain('strategy/overview.md')

    expect(existsSync(path.join(repoPath, '.claude'))).toBe(false)
    // `git init` writes info/exclude itself, so the claim is that BuildEx's own
    // block is absent from it — not that the file is.
    expect(readExclude()).not.toContain('buildex:begin')
    expect(mocks.refreshCompanyContext).not.toHaveBeenCalled()
  })

  it('still prepares the checkout for an ordinary scan', async () => {
    // The guard has to be the flag, not the removal of the behaviour: opening a
    // company's Brain is exactly when the gate should land.
    await scanChannel()(null, { repoPath })

    expect(readExclude()).toContain('buildex:begin')
    expect(existsSync(path.join(repoPath, '.claude', 'settings.json'))).toBe(true)
    expect(existsSync(path.join(repoPath, '.claude', 'skills', 'record-decision'))).toBe(true)
    expect(mocks.refreshCompanyContext).toHaveBeenCalledTimes(1)
  })
})
