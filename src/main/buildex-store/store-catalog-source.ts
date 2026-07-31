import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { app } from 'electron'
import type {
  CompanyMarketplace,
  StoreCatalog,
  StoreEntry,
  StoreRoster
} from '../../shared/buildex-store-types'
import type { BrainLocation } from '../../shared/buildex-brain-types'
import type { InstalledAppSummary } from '../buildex-brain/company-context'
import { readCompanyMarketplaces } from './company-marketplaces'
import { readInstalledPlugins } from './claude-plugin-install'
import { readInstalledPluginInventory } from './installed-plugin-inventory'
import {
  allMarketplaces,
  overlaysRootFrom,
  readStoreCatalog,
  type StoreMarketplaceSource
} from './marketplace-catalog'
import {
  isIndexStale,
  oldestFetchedAt,
  readCachedIndex,
  type CachedMarketplaceIndex
} from './marketplace-index-cache'
import { refreshMarketplaceIndexes } from './marketplace-fetch'
import { hasPluginCredential } from './plugin-credentials'
import { readStoreOverlays } from './store-overlay'

// The shelf, assembled in one place.
//
// Reading is cache-only and never touches the network: a PTY spawn and a brain
// open both need this and neither can afford to wait on a request. Fetching is
// an explicit call the Store makes, and only the Store makes.

// Why: overlays still ship with the app — they are BuildEx's own curation,
// versioned with the release, not a copy of somebody else's catalogue.
function resourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : resolve(process.cwd(), 'resources')
}

export type AppStoreCatalogOptions = {
  userDataPath?: string
  /** What the company expects installed. Only the Store's IPC has a repo to read it from. */
  roster?: StoreRoster | null
  /**
   * Marketplaces this company added, from the brain. Same reasoning as the
   * roster: this module does not know how to find a brain, so the caller that
   * has a repo resolves them and hands them in.
   */
  companyMarketplaces?: readonly CompanyMarketplace[]
  /** Where those marketplaces are written, for the "commit this" hint. */
  marketplacesPath?: string | null
  unsupportedAgent?: string | null
  now?: number
}

function cachedSources(
  userDataPath: string,
  company: readonly CompanyMarketplace[]
): {
  sources: StoreMarketplaceSource[]
  cached: (CachedMarketplaceIndex | null)[]
} {
  const marketplaces = allMarketplaces(company)
  const cached = marketplaces.map((marketplace) => readCachedIndex(userDataPath, marketplace.id))
  return {
    sources: marketplaces.map((marketplace, index) => ({
      ...marketplace,
      indexBody: cached[index]?.body ?? null
    })),
    cached
  }
}

/**
 * Read the shelf from what this machine has already fetched.
 *
 * An empty shelf here means the indexes have never been fetched, not that the
 * product has nothing to offer — `indexFetchedAt: null` is what tells the Store
 * to go and get them.
 */
export function readAppStoreCatalog(options: AppStoreCatalogOptions = {}): StoreCatalog {
  const userDataPath = options.userDataPath ?? app.getPath('userData')
  const now = options.now ?? Date.now()
  const { sources, cached } = cachedSources(userDataPath, options.companyMarketplaces ?? [])
  const fetchedAt = oldestFetchedAt(cached)
  const catalog = readStoreCatalog({
    marketplaces: sources,
    overlays: readStoreOverlays(overlaysRootFrom(resourceRoot())),
    installed: readInstalledPlugins(homedir()),
    roster: options.roster ?? null,
    marketplacesPath: options.marketplacesPath ?? null,
    unsupportedAgent: options.unsupportedAgent ?? null
  })
  return {
    ...catalog,
    indexFetchedAt: fetchedAt,
    indexStale: isIndexStale(fetchedAt, now),
    entries: catalog.entries.map((entry) => ({
      ...entry,
      credentialConnected: entry.overlay?.apiKey
        ? hasPluginCredential({ userDataPath }, entry.plugin.name)
        : undefined
    }))
  }
}

/** Fetch every marketplace index, then read the shelf back from the new cache. */
export async function refreshAppStoreCatalog(
  options: AppStoreCatalogOptions = {}
): Promise<{ catalog: StoreCatalog; errors: string[] }> {
  const userDataPath = options.userDataPath ?? app.getPath('userData')
  const now = options.now ?? Date.now()
  const outcomes = await refreshMarketplaceIndexes(
    userDataPath,
    allMarketplaces(options.companyMarketplaces ?? []),
    now
  )
  const errors = outcomes
    .filter((outcome) => !outcome.ok)
    .map((outcome) => `${outcome.marketplaceId}: ${outcome.error ?? 'failed'}`)
  return { catalog: readAppStoreCatalog({ ...options, userDataPath, now }), errors }
}

/**
 * What the company context should say is installed, for the brain surfaces that
 * refresh it without the Store being involved.
 *
 * The location is optional but wanted: without it, a plugin installed from a
 * marketplace this company added is not on the shelf to be recognised, and the
 * context would describe it as nothing at all.
 */
export function readInstalledAppSummaries(location?: BrainLocation | null): InstalledAppSummary[] {
  return readInstalledPluginInventory(homedir(), readCompanyStoreEntries(location))
}

/**
 * The shelf as one company sees it: the bundled marketplaces plus the ones its
 * brain adds.
 *
 * Reading it without the company's own marketplaces is not merely incomplete —
 * an app installed from one is then absent from the entries, and anything
 * deriving gate rules from them retires the rules that app is still relying on.
 */
export function readCompanyStoreEntries(location?: BrainLocation | null): StoreEntry[] {
  const companyMarketplaces = location ? readCompanyMarketplaces(location).entries : []
  return readAppStoreCatalog({ companyMarketplaces }).entries
}
