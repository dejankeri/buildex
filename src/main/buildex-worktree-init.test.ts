import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CompanyContextRefreshModule from './buildex-brain/company-context-refresh'

const mocks = vi.hoisted(() => ({
  readInstalledAppSummaries: vi.fn(() => [] as unknown[]),
  readCompanyStoreEntries: vi.fn(() => [] as unknown[]),
  /** Set by the deadline test: a scan that never comes back. */
  stallContextRefresh: false
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()) }
}))

vi.mock('./buildex-store/store-catalog-source', () => ({
  readInstalledAppSummaries: mocks.readInstalledAppSummaries,
  readCompanyStoreEntries: mocks.readCompanyStoreEntries,
  readAppStoreCatalog: vi.fn(() => ({ entries: [] }))
}))

vi.mock('./buildex-brain/company-context-refresh', async (importOriginal) => {
  const actual = await importOriginal<typeof CompanyContextRefreshModule>()
  return {
    refreshCompanyContext: (...args: Parameters<typeof actual.refreshCompanyContext>) =>
      mocks.stallContextRefresh
        ? new Promise<void>(() => {})
        : actual.refreshCompanyContext(...args)
  }
})

const { COMPANY_CONTEXT_DEADLINE_MS, gateCompanyWorktreeOnActivation, prepareCompanyWorktree } =
  await import('./buildex-worktree-init')
const { resetCompanyRepoInitialization } = await import('./buildex-repo-init')

function read(worktree: string, ...relative: string[]): string {
  return readFileSync(path.join(worktree, ...relative), 'utf8')
}

function askRules(worktree: string): string[] {
  const raw: unknown = JSON.parse(read(worktree, '.claude', 'settings.json'))
  return (raw as { permissions?: { ask?: string[] } }).permissions?.ask ?? []
}

describe('prepareCompanyWorktree', () => {
  let worktree: string

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readInstalledAppSummaries.mockReturnValue([])
    mocks.readCompanyStoreEntries.mockReturnValue([])
    mocks.stallContextRefresh = false
    resetCompanyRepoInitialization()
    worktree = mkdtempSync(path.join(tmpdir(), 'buildex-worktree-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(worktree, { recursive: true, force: true })
  })

  function writeBrainDocument(): void {
    mkdirSync(path.join(worktree, '.buildex', 'decisions'), { recursive: true })
    writeFileSync(
      path.join(worktree, '.buildex', 'decisions', 'pricing.md'),
      '# Pricing\n\nAnnual only.\n',
      'utf8'
    )
  }

  it('leaves the context, the import and the gate on disk before it resolves', async () => {
    writeBrainDocument()

    await prepareCompanyWorktree(worktree)

    expect(read(worktree, '.claude', 'company-context.md')).toContain('pricing')
    expect(read(worktree, '.claude', 'CLAUDE.md')).toContain('@./company-context.md')
    expect(read(worktree, '.claude', 'CLAUDE.md')).toContain(
      '<!-- buildex:company-context:begin -->'
    )
    expect(askRules(worktree).length).toBeGreaterThan(0)
  })

  it('gates a worktree whose repo has no brain, and writes it no context', async () => {
    await prepareCompanyWorktree(worktree)

    expect(askRules(worktree).length).toBeGreaterThan(0)
    expect(existsSync(path.join(worktree, '.claude', 'company-context.md'))).toBe(false)
  })

  it('still gates the worktree when the brain cannot be read', async () => {
    writeBrainDocument()
    mocks.readInstalledAppSummaries.mockImplementation(() => {
      throw new Error('shelf unreadable')
    })

    await expect(prepareCompanyWorktree(worktree)).resolves.toBeUndefined()

    expect(askRules(worktree).length).toBeGreaterThan(0)
    expect(existsSync(path.join(worktree, '.claude', 'company-context.md'))).toBe(false)
  })

  it('gives up on a scan that never comes back, and still yields a gated worktree', async () => {
    writeBrainDocument()
    mocks.stallContextRefresh = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()

    const preparing = prepareCompanyWorktree(worktree)
    await vi.advanceTimersByTimeAsync(COMPANY_CONTEXT_DEADLINE_MS)

    await expect(preparing).resolves.toBeUndefined()
    expect(askRules(worktree).length).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(worktree))
    warn.mockRestore()
  })

  it('writes nothing for a path this machine cannot see', async () => {
    const absent = path.join(worktree, 'never-created')

    await prepareCompanyWorktree(absent)

    expect(existsSync(absent)).toBe(false)
  })
})

describe('gateCompanyWorktreeOnActivation', () => {
  let worktree: string

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readCompanyStoreEntries.mockReturnValue([])
    resetCompanyRepoInitialization()
    worktree = mkdtempSync(path.join(tmpdir(), 'buildex-activated-'))
  })

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
  })

  it('gates a checkout the operator opened rather than created', () => {
    gateCompanyWorktreeOnActivation(worktree)

    expect(askRules(worktree).length).toBeGreaterThan(0)
  })

  it('writes no context — a spawn is not the place to wait for a git scan', () => {
    mkdirSync(path.join(worktree, '.buildex'), { recursive: true })
    writeFileSync(path.join(worktree, '.buildex', 'handbook.md'), '# Handbook\n', 'utf8')

    gateCompanyWorktreeOnActivation(worktree)

    expect(existsSync(path.join(worktree, '.claude', 'company-context.md'))).toBe(false)
  })

  it('leaves a bare shell and a path this machine does not have alone', () => {
    const elsewhere = path.join(worktree, 'not-on-this-disk')

    gateCompanyWorktreeOnActivation(undefined)
    gateCompanyWorktreeOnActivation(elsewhere)

    expect(existsSync(elsewhere)).toBe(false)
  })

  it('writes nothing for a worktree on another host, even when the path exists here', () => {
    // Why: a remote worktree's path is the remote filesystem's. A local directory
    // at the same path is a different directory, and gating it would leave the
    // real checkout ungated while writing into something unrelated.
    gateCompanyWorktreeOnActivation(worktree, 'ssh-connection-1')

    expect(existsSync(path.join(worktree, '.claude'))).toBe(false)
  })

  it("gates from the company's own shelf, not one that cannot see its marketplaces", () => {
    const privateTool = 'mcp__beta__pay'
    mocks.readCompanyStoreEntries.mockImplementation((location?: { gitRoot?: string } | null) =>
      location?.gitRoot === worktree
        ? [{ installed: true, overlay: { gate: { ask: [privateTool] } } }]
        : []
    )

    gateCompanyWorktreeOnActivation(worktree)

    expect(askRules(worktree)).toContain(privateTool)
  })
})
