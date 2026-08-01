import type { StoreOverlay, StorePlugin, StoreSegment } from '../../shared/buildex-store-types'

// Which shelf a plugin lands on.
//
// This is curation, so the per-plugin answer is data: it lives in the overlay
// files beside the gate and the credential, and an overlay that carries only a
// segment says where the app sits and nothing more.
//
// What is left here is the fallback for the hundreds of plugins nobody has
// written an overlay for. Upstream's own categories are the starting point but
// they are dev-weighted and imprecise — `productivity` holds asana, notion and
// slack next to code-review, github and gitlab — so the map gets the bulk right
// and a placement overlay fixes each exception.

/** Upstream categories whose plugins are for someone running a business. */
const BUSINESS_CATEGORIES = new Set(['productivity', 'design', 'automation'])

/**
 * The shelf for one plugin.
 *
 * An overlay wins outright — BuildEx wrote it and it is the strongest statement
 * of intent. After that the category, then whatever the marketplace defaults to,
 * which is how a company's own marketplace lands its plugins somewhere sensible
 * without categorising anything.
 */
export function segmentForPlugin(
  plugin: StorePlugin,
  marketplaceDefault: StoreSegment,
  overlay: StoreOverlay | null
): StoreSegment {
  if (overlay?.segment) {
    return overlay.segment
  }
  const category = plugin.category?.toLowerCase()
  if (category) {
    return BUSINESS_CATEGORIES.has(category) ? 'business' : 'software'
  }
  return marketplaceDefault
}
