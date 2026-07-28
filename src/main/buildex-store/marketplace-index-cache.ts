import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The marketplace indexes this machine has fetched.
//
// Under userData, not the repo: an index is a copy of somebody else's catalogue,
// not company work, and two projects on one machine should share the one fetch.
//
// The cache is the only source the shelf is built from. Reading it never touches
// the network, which is what lets a terminal spawn and a brain refresh assemble
// the shelf without waiting on anything.

const CACHE_DIR_NAME = 'marketplace-index'
/** Long enough that opening the Store repeatedly costs nothing, short enough to stay current. */
export const INDEX_STALE_AFTER_MS = 6 * 60 * 60 * 1000
const MARKETPLACE_ID_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i

export type CachedMarketplaceIndex = {
  body: string
  /** Epoch ms of the fetch this came from. */
  fetchedAt: number
}

function cacheDir(userDataPath: string): string {
  return path.join(userDataPath, CACHE_DIR_NAME)
}

/** Null for an id that could walk out of the cache directory. */
function cachePath(userDataPath: string, marketplaceId: string): string | null {
  return MARKETPLACE_ID_RE.test(marketplaceId)
    ? path.join(cacheDir(userDataPath), `${marketplaceId}.json`)
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function readCachedIndex(
  userDataPath: string,
  marketplaceId: string
): CachedMarketplaceIndex | null {
  const target = cachePath(userDataPath, marketplaceId)
  if (!target) {
    return null
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(target, 'utf8'))
    if (!isRecord(raw) || typeof raw.body !== 'string' || typeof raw.fetchedAt !== 'number') {
      return null
    }
    return { body: raw.body, fetchedAt: raw.fetchedAt }
  } catch {
    // Never fetched, or a cache entry we cannot read. Both mean "fetch it".
    return null
  }
}

export function writeCachedIndex(
  userDataPath: string,
  marketplaceId: string,
  body: string,
  fetchedAt: number
): boolean {
  const target = cachePath(userDataPath, marketplaceId)
  if (!target) {
    return false
  }
  try {
    mkdirSync(cacheDir(userDataPath), { recursive: true })
    writeFileSync(target, JSON.stringify({ fetchedAt, body }), 'utf8')
    return true
  } catch {
    // A cache we cannot write costs a fetch next time, nothing more.
    return false
  }
}

/** Drop a marketplace's cache — used when a company removes one it added. */
export function clearCachedIndex(userDataPath: string, marketplaceId: string): void {
  const target = cachePath(userDataPath, marketplaceId)
  if (!target) {
    return
  }
  try {
    rmSync(target, { force: true })
  } catch {
    // Already gone is the outcome the caller wanted.
  }
}

/** Marketplace ids this machine holds an index for. */
export function cachedMarketplaceIds(userDataPath: string): string[] {
  if (!existsSync(cacheDir(userDataPath))) {
    return []
  }
  try {
    return readdirSync(cacheDir(userDataPath))
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.replace(/\.json$/, ''))
      .sort()
  } catch {
    return []
  }
}

/**
 * The oldest fetch among the indexes we have, or null when we have none.
 *
 * The oldest rather than the newest: the shelf is only as current as its
 * staleest part, and one marketplace silently failing to refresh is exactly the
 * case worth surfacing.
 */
export function oldestFetchedAt(
  indexes: readonly (CachedMarketplaceIndex | null)[]
): number | null {
  const stamps = indexes.filter((index): index is CachedMarketplaceIndex => index !== null)
  return stamps.length === 0 ? null : Math.min(...stamps.map((index) => index.fetchedAt))
}

export function isIndexStale(fetchedAt: number | null, now: number): boolean {
  return fetchedAt === null || now - fetchedAt >= INDEX_STALE_AFTER_MS
}
