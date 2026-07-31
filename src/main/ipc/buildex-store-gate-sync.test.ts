import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreCatalog, StoreEntry, StoreInstallResult } from '../../shared/buildex-store-types'
import { EMPTY_STORE_CATALOG } from '../../shared/buildex-store-types'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  installClaudePlugin: vi.fn(),
  uninstallClaudePlugin: vi.fn(),
  readAppStoreCatalog: vi.fn(),
  refreshAppStoreCatalog: vi.fn(),
  readInstalledAppSummaries: vi.fn(() => []),
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
  readInstalledAppSummaries: mocks.readInstalledAppSummaries
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

const GATED_TOOL = 'mcp__acme__send_invoice'

function entry(installed: boolean): StoreEntry {
  return {
    plugin: {
      name: 'acme',
      displayName: 'Acme',
      description: 'Invoices',
      category: null,
      author: null,
      homepage: null,
      keywords: [],
      source: { kind: 'marketplace-relative', path: 'acme' }
    },
    marketplaceId: 'acme-market',
    marketplaceLabel: 'Acme Market',
    segment: 'business',
    curated: true,
    overlay: { pluginName: 'acme', gate: { ask: [GATED_TOOL] } },
    installed
  }
}

function catalog(installed: boolean): StoreCatalog {
  return {
    ...EMPTY_STORE_CATALOG,
    entries: [entry(installed)],
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

  beforeEach(() => {
    vi.clearAllMocks()
    resetCompanyRepoInitialization()
    firstCompany = mkdtempSync(path.join(tmpdir(), 'buildex-company-a-'))
    secondCompany = mkdtempSync(path.join(tmpdir(), 'buildex-company-b-'))
    mocks.readInstalledAppSummaries.mockReturnValue([])
    mocks.readInstalledPluginInventory.mockReturnValue([])
    mocks.readAppStoreCatalog.mockReturnValue(catalog(false))
    mocks.installClaudePlugin.mockReturnValue({ ok: true } satisfies StoreInstallResult)
    registerBuildExStoreHandlers()
  })

  afterEach(() => {
    rmSync(firstCompany, { recursive: true, force: true })
    rmSync(secondCompany, { recursive: true, force: true })
  })

  it("writes the new app's ask rules into a second company opened this run", () => {
    handler('buildex-store:catalog')(null, { repoPath: secondCompany })
    handler('buildex-store:catalog')(null, { repoPath: firstCompany })
    expect(askRules(secondCompany)).not.toContain(GATED_TOOL)

    mocks.readAppStoreCatalog.mockReturnValue(catalog(true))
    const result = handler('buildex-store:install')(null, {
      repoPath: firstCompany,
      pluginName: 'acme',
      marketplaceId: 'acme-market'
    })

    expect(result).toMatchObject({ ok: true })
    expect(askRules(firstCompany)).toContain(GATED_TOOL)
    expect(askRules(secondCompany)).toContain(GATED_TOOL)
  })

  it('keeps the preset rules of a company the install never touched', () => {
    handler('buildex-store:catalog')(null, { repoPath: secondCompany })
    const presetRules = askRules(secondCompany)
    expect(presetRules.length).toBeGreaterThan(0)

    mocks.readAppStoreCatalog.mockReturnValue(catalog(true))
    handler('buildex-store:install')(null, {
      repoPath: firstCompany,
      pluginName: 'acme',
      marketplaceId: 'acme-market'
    })

    expect(askRules(secondCompany)).toEqual([...presetRules, GATED_TOOL])
  })

  it('uninstalling takes the rules back out of every open company', () => {
    handler('buildex-store:catalog')(null, { repoPath: secondCompany })
    mocks.readAppStoreCatalog.mockReturnValue(catalog(true))
    handler('buildex-store:install')(null, {
      repoPath: firstCompany,
      pluginName: 'acme',
      marketplaceId: 'acme-market'
    })
    expect(askRules(secondCompany)).toContain(GATED_TOOL)

    mocks.uninstallClaudePlugin.mockReturnValue({ ok: true } satisfies StoreInstallResult)
    mocks.readAppStoreCatalog.mockReturnValue(catalog(false))
    handler('buildex-store:uninstall')(null, {
      repoPath: firstCompany,
      pluginName: 'acme',
      marketplaceId: 'acme-market'
    })

    expect(askRules(secondCompany)).not.toContain(GATED_TOOL)
  })
})
