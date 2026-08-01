import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrainLocation } from '../../shared/buildex-brain-types'
import type { StoreCatalog, StoreEntry, StoreInstallResult } from '../../shared/buildex-store-types'
import { EMPTY_STORE_CATALOG } from '../../shared/buildex-store-types'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  installClaudePlugin: vi.fn(),
  uninstallClaudePlugin: vi.fn(),
  readAppStoreCatalog: vi.fn(),
  refreshAppStoreCatalog: vi.fn(),
  readInstalledAppSummaries: vi.fn(() => []),
  readCompanyStoreEntries: vi.fn(() => [] as StoreEntry[]),
  readInstalledPluginInventory: vi.fn(() => []),
  refreshCompanyContext: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()) },
  ipcMain: { handle: mocks.handle }
}))

vi.mock('../buildex-store/claude-plugin-install', () => ({
  installClaudePlugin: mocks.installClaudePlugin,
  uninstallClaudePlugin: mocks.uninstallClaudePlugin
}))

vi.mock('../buildex-store/claude-cli-runner', () => ({
  resolveClaudeBinary: vi.fn(() => 'claude'),
  runClaudeCommand: vi.fn(() => ({ ok: true, stdout: '', stderr: '' }))
}))

vi.mock('../buildex-store/store-catalog-source', () => ({
  readAppStoreCatalog: mocks.readAppStoreCatalog,
  refreshAppStoreCatalog: mocks.refreshAppStoreCatalog,
  readInstalledAppSummaries: mocks.readInstalledAppSummaries,
  readCompanyStoreEntries: mocks.readCompanyStoreEntries
}))

vi.mock('../buildex-store/installed-plugin-inventory', () => ({
  readInstalledPluginInventory: mocks.readInstalledPluginInventory
}))

vi.mock('../buildex-brain/company-context-refresh', () => ({
  refreshCompanyContext: mocks.refreshCompanyContext
}))

vi.mock('./buildex-store-marketplaces', () => ({
  registerStoreMarketplaceHandlers: vi.fn()
}))

const { registerBuildExStoreHandlers } = await import('./buildex-store')
const { resetCompanyRepoInitialization } = await import('../buildex-repo-init')

/** On the bundled shelf, so every company can see it. */
const ACME_TOOL = 'mcp__acme__send_invoice'
/** Only on the second company's own marketplace. Nobody else's catalogue has it. */
const BETA_TOOL = 'mcp__beta__pay'

function entry(name: string, marketplaceId: string, gatedTool: string, installed: boolean) {
  return {
    plugin: {
      name,
      displayName: name,
      description: 'An app',
      category: null,
      author: null,
      homepage: null,
      keywords: [],
      source: { url: null, path: name }
    },
    marketplaceId,
    marketplaceLabel: marketplaceId,
    segment: 'business' as const,
    curated: true,
    overlay: { pluginName: name, gate: { ask: [gatedTool] } },
    installed
  } satisfies StoreEntry
}

/** What a company whose brain adds no marketplace of its own can see. */
function bundledEntries(acmeInstalled: boolean): StoreEntry[] {
  return [entry('acme', 'acme-market', ACME_TOOL, acmeInstalled)]
}

function catalog(acmeInstalled: boolean): StoreCatalog {
  return {
    ...EMPTY_STORE_CATALOG,
    entries: bundledEntries(acmeInstalled),
    marketplaces: [
      {
        id: 'acme-market',
        label: 'Acme Market',
        repo: 'acme/market',
        origin: 'bundled',
        defaultSegment: 'business'
      }
    ]
  }
}

function handler(channel: string): (event: unknown, request?: unknown) => unknown {
  const registered = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!registered) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return registered[1] as (event: unknown, request?: unknown) => unknown
}

function askRules(repoPath: string): string[] {
  const raw: unknown = JSON.parse(
    readFileSync(path.join(repoPath, '.claude', 'settings.json'), 'utf8')
  )
  const permissions = (raw as { permissions?: { ask?: string[] } }).permissions
  return permissions?.ask ?? []
}

describe('installing an app gates every open company repo', () => {
  let firstCompany: string
  let secondCompany: string
  let acmeInstalled: boolean

  beforeEach(() => {
    vi.clearAllMocks()
    resetCompanyRepoInitialization()
    firstCompany = mkdtempSync(path.join(tmpdir(), 'buildex-company-a-'))
    secondCompany = mkdtempSync(path.join(tmpdir(), 'buildex-company-b-'))
    acmeInstalled = false
    mocks.readInstalledAppSummaries.mockReturnValue([])
    mocks.readInstalledPluginInventory.mockReturnValue([])
    mocks.readAppStoreCatalog.mockImplementation(() => catalog(acmeInstalled))
    // Why: a catalogue only carries the marketplaces it was given. The second
    // company's brain adds one of its own, so its shelf holds an app the first
    // company's shelf cannot see — which is exactly the case a shared rule set
    // would silently un-gate.
    mocks.readCompanyStoreEntries.mockImplementation((location?: BrainLocation | null) =>
      location?.gitRoot === secondCompany
        ? [...bundledEntries(acmeInstalled), entry('beta', 'beta-market', BETA_TOOL, true)]
        : bundledEntries(acmeInstalled)
    )
    mocks.installClaudePlugin.mockReturnValue({ ok: true } satisfies StoreInstallResult)
    registerBuildExStoreHandlers()
  })

  afterEach(() => {
    rmSync(firstCompany, { recursive: true, force: true })
    rmSync(secondCompany, { recursive: true, force: true })
  })

  function openStoreFor(repoPath: string): void {
    handler('buildex-store:catalog')(null, { repoPath })
  }

  function installAcmeFrom(repoPath: string): unknown {
    acmeInstalled = true
    return handler('buildex-store:install')(null, {
      repoPath,
      pluginName: 'acme',
      marketplaceId: 'acme-market'
    })
  }

  it("writes the new app's ask rules into a second company opened this run", () => {
    openStoreFor(secondCompany)
    openStoreFor(firstCompany)
    expect(askRules(secondCompany)).not.toContain(ACME_TOOL)

    const result = installAcmeFrom(firstCompany)

    expect(result).toMatchObject({ ok: true })
    expect(askRules(firstCompany)).toContain(ACME_TOOL)
    expect(askRules(secondCompany)).toContain(ACME_TOOL)
  })

  it('leaves a second company still gated on an app only its own marketplace carries', () => {
    openStoreFor(secondCompany)
    expect(askRules(secondCompany)).toContain(BETA_TOOL)

    installAcmeFrom(firstCompany)

    // The first company's catalogue has no `beta` entry at all. Gating the second
    // company from it would retire a rule for an app it still has installed.
    expect(askRules(secondCompany)).toContain(BETA_TOOL)
    expect(askRules(firstCompany)).not.toContain(BETA_TOOL)
  })

  it('keeps the preset rules of a company the install never touched', () => {
    openStoreFor(secondCompany)
    const before = askRules(secondCompany)
    expect(before.length).toBeGreaterThan(0)

    installAcmeFrom(firstCompany)

    expect(askRules(secondCompany)).toEqual([...before, ACME_TOOL])
  })

  it('does not resurrect a worktree the operator or an automation has removed', () => {
    openStoreFor(secondCompany)
    rmSync(secondCompany, { recursive: true, force: true })

    installAcmeFrom(firstCompany)

    expect(existsSync(secondCompany)).toBe(false)
    expect(askRules(firstCompany)).toContain(ACME_TOOL)
  })

  it('uninstalling takes the rules back out of every open company', () => {
    openStoreFor(secondCompany)
    installAcmeFrom(firstCompany)
    expect(askRules(secondCompany)).toContain(ACME_TOOL)

    mocks.uninstallClaudePlugin.mockReturnValue({ ok: true } satisfies StoreInstallResult)
    acmeInstalled = false
    handler('buildex-store:uninstall')(null, {
      repoPath: firstCompany,
      pluginName: 'acme',
      marketplaceId: 'acme-market'
    })

    expect(askRules(secondCompany)).not.toContain(ACME_TOOL)
    expect(askRules(secondCompany)).toContain(BETA_TOOL)
  })
})
