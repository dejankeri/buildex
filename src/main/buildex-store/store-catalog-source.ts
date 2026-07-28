import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { app } from 'electron'
import type { StoreCatalog, StoreRoster } from '../../shared/buildex-store-types'
import type { InstalledAppSummary } from '../buildex-brain/company-context'
import { readInstalledPlugins } from './claude-plugin-install'
import { readInstalledPluginInventory } from './installed-plugin-inventory'
import {
  KNOWN_MARKETPLACES,
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
  unsupportedAgent?: string | null
  now?: number
}

function cachedSources(userDataPath: string): {
  sources: StoreMarketplaceSource[]
  cached: (CachedMarketplaceIndex | null)[]
} {
  const cached = KNOWN_MARKETPLACES.map((marketplace) =>
    readCachedIndex(userDataPath, marketplace.id)
  )
  return {
    sources: KNOWN_MARKETPLACES.map((marketplace, index) => ({
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
  const { sources, cached } = cachedSources(userDataPath)
  const fetchedAt = oldestFetchedAt(cached)
  const catalog = readStoreCatalog({
    marketplaces: sources,
    overlays: readStoreOverlays(overlaysRootFrom(resourceRoot())),
    installed: readInstalledPlugins(homedir()),
    roster: options.roster ?? null,
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
  const outcomes = await refreshMarketplaceIndexes(userDataPath, KNOWN_MARKETPLACES, now)
  const errors = outcomes
    .filter((outcome) => !outcome.ok)
    .map((outcome) => `${outcome.marketplaceId}: ${outcome.error ?? 'failed'}`)
  return { catalog: readAppStoreCatalog({ ...options, userDataPath, now }), errors }
}

/**
 * What the company context should say is installed, for the brain surfaces that
 * refresh it without the Store being involved.
 */
export function readInstalledAppSummaries(): InstalledAppSummary[] {
  return readInstalledPluginInventory(homedir(), readAppStoreCatalog().entries)
}
