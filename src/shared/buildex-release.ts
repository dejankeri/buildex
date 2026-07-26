// Single source of truth for where BuildEx looks for its own updates.
//
// Why this exists: Orca hardcodes `stablyai/orca` release URLs in several
// modules. If a fork leaves any one of them pointing upstream, its users
// silently auto-update *into Orca* and lose the fork. Centralising the slug
// makes that failure impossible to reintroduce one file at a time.
//
// The target repo does not exist yet. That is deliberate and fail-safe: an
// update check against a missing repo 404s and no update is applied, whereas a
// stale upstream URL would install a different product.

export const BUILDEX_RELEASE_REPO_OWNER = 'dejankeri'
export const BUILDEX_RELEASE_REPO_NAME = 'buildex'
export const BUILDEX_RELEASE_REPO_SLUG = `${BUILDEX_RELEASE_REPO_OWNER}/${BUILDEX_RELEASE_REPO_NAME}`

const REPO_BASE_URL = `https://github.com/${BUILDEX_RELEASE_REPO_SLUG}`

export const BUILDEX_RELEASES_LATEST_DOWNLOAD_URL = `${REPO_BASE_URL}/releases/latest/download`
export const BUILDEX_RELEASES_DOWNLOAD_BASE = `${REPO_BASE_URL}/releases/download`
export const BUILDEX_RELEASES_ATOM_FEED_URL = `${REPO_BASE_URL}/releases.atom`

/** Matches release-tag hrefs in the atom feed for this fork's repo. */
export function createReleaseTagHrefPattern(): RegExp {
  // Why: built per call — a module-level regex with /g carries lastIndex
  // between scans and would skip matches on the second feed parse.
  const escapedSlug = BUILDEX_RELEASE_REPO_SLUG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`href="https://github\\.com/${escapedSlug}/releases/tag/([^"]+)"`, 'g')
}
