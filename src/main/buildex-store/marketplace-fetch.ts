import { net } from 'electron'
import type { StoreMarketplace } from '../../shared/buildex-store-types'
import { writeCachedIndex } from './marketplace-index-cache'

// Fetching a marketplace's index.
//
// Why net.fetch and not fetch: Electron's `net` respects the app's proxy and
// certificate settings, which is what makes this work on a corporate network —
// and bare global fetch goes through Node's bundled undici, which this repo
// bans outright because an unread body can take the whole process down. See
// src/main/global-fetch-call-site-audit.test.ts.
//
// The raw file rather than the git clone the CLI does: we only need the index to
// draw a shelf, and one small GET beats cloning a repo to read one file. The CLI
// still does its own clone when something is actually installed.

const FETCH_TIMEOUT_MS = 15_000
/** Upstream's index is ~160 kB; this is room to grow, not a target. */
const MAX_INDEX_BYTES = 8 * 1024 * 1024
const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/

/**
 * Where a marketplace's index lives.
 *
 * `HEAD` rather than a branch name: `main` and `master` both exist in the wild,
 * and HEAD is whatever the repo says its default is.
 */
export function marketplaceIndexUrl(repo: string): string | null {
  if (REPO_SLUG_RE.test(repo)) {
    return `https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/marketplace.json`
  }
  // A company can point at a full URL to a marketplace.json of its own.
  return /^https:\/\//i.test(repo) ? repo : null
}

export type MarketplaceFetchOutcome = {
  marketplaceId: string
  ok: boolean
  error?: string
}

/** Fetch one index. Returns its body, or null with the reason on the outcome. */
export async function fetchMarketplaceIndex(
  repo: string
): Promise<{ body: string } | { error: string }> {
  const url = marketplaceIndexUrl(repo)
  if (!url) {
    return { error: `Not a marketplace this can fetch: ${repo}` }
  }
  let response: Response
  try {
    response = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (!response.ok) {
    // Why: the body must be consumed or cancelled on every path, including the
    // failure one, or the connection is left holding a paused parser.
    await response.body?.cancel()
    return { error: `${response.status} ${response.statusText}` }
  }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_INDEX_BYTES) {
    await response.body?.cancel()
    return { error: 'Index is implausibly large' }
  }
  try {
    const body = await response.text()
    return body.length > MAX_INDEX_BYTES ? { error: 'Index is implausibly large' } : { body }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Refresh every marketplace, writing what came back into the cache.
 *
 * One marketplace failing does not fail the rest: a company marketplace behind a
 * VPN should not stop Anthropic's from refreshing. The previous cache entry for
 * a failed fetch is left exactly where it is, so a refresh that cannot reach the
 * network leaves the operator with the shelf they already had.
 */
export async function refreshMarketplaceIndexes(
  userDataPath: string,
  marketplaces: readonly StoreMarketplace[],
  now: number
): Promise<MarketplaceFetchOutcome[]> {
  return Promise.all(
    marketplaces.map(async (marketplace) => {
      const result = await fetchMarketplaceIndex(marketplace.repo)
      if ('error' in result) {
        return { marketplaceId: marketplace.id, ok: false, error: result.error }
      }
      const written = writeCachedIndex(userDataPath, marketplace.id, result.body, now)
      return written
        ? { marketplaceId: marketplace.id, ok: true }
        : { marketplaceId: marketplace.id, ok: false, error: 'Could not write the index cache' }
    })
  )
}
