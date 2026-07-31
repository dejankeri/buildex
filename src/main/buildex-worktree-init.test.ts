import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readInstalledAppSummaries: vi.fn(() => [] as unknown[])
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()) }
}))

vi.mock('./buildex-store/store-catalog-source', () => ({
  readInstalledAppSummaries: mocks.readInstalledAppSummaries,
  readAppStoreCatalog: vi.fn(() => ({ entries: [] }))
}))

const { prepareCompanyWorktree } = await import('./buildex-worktree-init')
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
    resetCompanyRepoInitialization()
    worktree = mkdtempSync(path.join(tmpdir(), 'buildex-worktree-'))
  })

  afterEach(() => {
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

  it('writes nothing for a path this machine cannot see', async () => {
    const absent = path.join(worktree, 'never-created')

    await prepareCompanyWorktree(absent)

    expect(existsSync(absent)).toBe(false)
  })
})
