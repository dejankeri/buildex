import type { StoreOverlay, StorePlugin, StoreSegment } from '../../shared/buildex-store-types'

// Which shelf a plugin lands on.
//
// This is curation, so it is data rather than logic. Upstream's own categories
// are the starting point but they are dev-weighted and imprecise: `productivity`
// holds asana, notion and slack next to code-review, github and gitlab. The map
// below gets most of it right and the override list fixes the rest, and both are
// meant to be edited as the marketplace grows.

/** Upstream categories whose plugins are for someone running a business. */
const BUSINESS_CATEGORIES = new Set(['productivity', 'design', 'automation'])

/**
 * Filed under a business category upstream, but developer tooling. Without this
 * the "Run your business" shelf opens on `commit-commands` and `code-review`.
 */
const SOFTWARE_OVERRIDES = new Set([
  'claude-code-setup',
  'claude-md-management',
  'code-review',
  'code-simplifier',
  'coderabbit',
  'commit-commands',
  'cwc-makers',
  'desktop-commander',
  'exa',
  'github',
  'gitlab',
  'hookify'
])

/**
 * Filed under a developer category upstream, but the plugin an operator wants.
 * Kept separate from the overlays: an entry here changes only which shelf a
 * plugin appears on, and claims nothing about BuildEx having vetted it.
 */
const BUSINESS_OVERRIDES = new Set<string>([])

/**
 * The shelf for one plugin.
 *
 * An overlay wins outright — BuildEx wrote it and it is the strongest statement
 * of intent. After that the per-plugin lists, then the category, then whatever
 * the marketplace defaults to, which is how a company's own marketplace lands
 * its plugins somewhere sensible without categorising anything.
 */
export function segmentForPlugin(
  plugin: StorePlugin,
  marketplaceDefault: StoreSegment,
  overlay: StoreOverlay | null
): StoreSegment {
  if (overlay?.segment) {
    return overlay.segment
  }
  if (SOFTWARE_OVERRIDES.has(plugin.name)) {
    return 'software'
  }
  if (BUSINESS_OVERRIDES.has(plugin.name)) {
    return 'business'
  }
  const category = plugin.category?.toLowerCase()
  if (category) {
    return BUSINESS_CATEGORIES.has(category) ? 'business' : 'software'
  }
  return marketplaceDefault
}
