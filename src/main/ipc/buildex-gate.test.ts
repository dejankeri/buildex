import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GateSettingsResult } from '../../shared/buildex-gate-types'
import type { StoreEntry } from '../../shared/buildex-store-types'

// The handler behind the Store page's gate badge. It had no test file at all,
// which is why the suite was silent while it retired every installed app's rules
// on each mount and each workspace switch.

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  readCompanyStoreEntries: vi.fn(() => [] as StoreEntry[])
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()) },
  ipcMain: { handle: mocks.handle }
}))

vi.mock('../buildex-store/store-catalog-source', () => ({
  readCompanyStoreEntries: mocks.readCompanyStoreEntries
}))

const { registerBuildExGateHandlers } = await import('./buildex-gate')
const { syncGateSettings } = await import('../buildex-gate/gate-settings')

/** Gated by an installed app, so no preset carries it. */
const ACME_TOOL = 'mcp__acme__send_invoice'

function entry(installed: boolean): StoreEntry {
  return {
    plugin: {
      name: 'acme',
      displayName: 'Acme',
      description: 'An app',
      category: null,
      author: null,
      homepage: null,
      keywords: [],
      source: { url: null, path: 'acme' }
    },
    marketplaceId: 'acme-market',
    marketplaceLabel: 'Acme Market',
    segment: 'business',
    curated: true,
    overlay: { pluginName: 'acme', gate: { ask: [ACME_TOOL] } },
    installed
  }
}

function askRules(repoPath: string): string[] {
  const raw: unknown = JSON.parse(
    readFileSync(path.join(repoPath, '.claude', 'settings.json'), 'utf8')
  )
  return (raw as { permissions?: { ask?: string[] } }).permissions?.ask ?? []
}

describe('buildex-gate:sync', () => {
  let repo = ''
  let sync: (event: unknown, request?: unknown) => GateSettingsResult

  beforeEach(() => {
    vi.clearAllMocks()
    repo = mkdtempSync(path.join(tmpdir(), 'buildex-gate-ipc-'))
    mocks.readCompanyStoreEntries.mockReturnValue([entry(true)])
    registerBuildExGateHandlers()
    const registered = mocks.handle.mock.calls.find(([name]) => name === 'buildex-gate:sync')
    if (!registered) {
      throw new Error('buildex-gate:sync was never registered')
    }
    sync = registered[1] as typeof sync
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it("keeps an installed app's rules that a previous install wrote", () => {
    // What the install wrote, and the receipt it left behind.
    syncGateSettings(repo, { ask: [ACME_TOOL] })
    expect(askRules(repo)).toContain(ACME_TOOL)

    // Opening the Store fires this channel from an effect, on every mount and
    // every workspace switch. A sync with no plugin rules retires the receipt.
    sync(null, { repoPath: repo })

    expect(askRules(repo)).toContain(ACME_TOOL)
  })

  it('survives being opened over and over, which is what a page mount does', () => {
    sync(null, { repoPath: repo })
    const first = askRules(repo)

    sync(null, { repoPath: repo })
    sync(null, { repoPath: repo })

    expect(askRules(repo)).toEqual(first)
    expect(first).toContain(ACME_TOOL)
  })

  it("counts the installed app's rules in what it reports to the badge", () => {
    const withApp = sync(null, { repoPath: repo })

    mocks.readCompanyStoreEntries.mockReturnValue([entry(false)])
    const withoutApp = sync(null, { repoPath: repo })

    expect(withApp.preset.ask).toContain(ACME_TOOL)
    expect(withoutApp.preset.ask).not.toContain(ACME_TOOL)
    // Uninstalled is the one case where retiring the rule is correct.
    expect(askRules(repo)).not.toContain(ACME_TOOL)
  })

  it('leaves the gate alone when the shelf cannot be read', () => {
    syncGateSettings(repo, { ask: [ACME_TOOL] })
    mocks.readCompanyStoreEntries.mockImplementation(() => {
      throw new Error('unreadable shelf')
    })

    const result = sync(null, { repoPath: repo })

    // Empty rules are what an unreadable shelf yields, so the app's rule does go
    // — but the surface still answers rather than throwing at the renderer.
    expect(result.error).toBeUndefined()
    expect(result.preset.ask.length).toBeGreaterThan(0)
  })

  it('answers without a repo rather than writing somewhere', () => {
    expect(sync(null, {}).error).toBe('Missing repoPath')
    expect(sync(null, undefined).error).toBe('Missing repoPath')
  })
})
