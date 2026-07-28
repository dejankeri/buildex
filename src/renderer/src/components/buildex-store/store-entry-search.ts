import type { StoreEntry, StoreSegment } from '../../../../shared/buildex-store-types'

// Search is the only workable way through a shelf this size — the official
// marketplace alone carries hundreds of plugins, so browsing without it is not a
// design the page can offer.

/** A plugin name is unique per marketplace, not across them. */
export function storeEntryKey(entry: StoreEntry): string {
  return `${entry.marketplaceId}/${entry.plugin.name}`
}

/** What the card actually shows, which is what a search has to match. */
export function storeEntryDescription(entry: StoreEntry): string {
  return entry.overlay?.summary ?? entry.plugin.description
}

export function storeEntryDisplayName(entry: StoreEntry): string {
  return entry.plugin.displayName || entry.plugin.name
}

function searchableText(entry: StoreEntry): string {
  return [
    storeEntryDisplayName(entry),
    entry.plugin.name,
    storeEntryDescription(entry),
    ...entry.plugin.keywords
  ]
    .join(' ')
    .toLowerCase()
}

/** Every token must match, so adding a word narrows rather than widens. */
export function matchesStoreQuery(entry: StoreEntry, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return true
  }
  const haystack = searchableText(entry)
  return tokens.every((token) => haystack.includes(token))
}

/**
 * Both shelves in one pass. The Store needs both even while showing one, because
 * the tab counts are what tell an operator their search hit the other shelf —
 * the same app legitimately sits on both.
 */
export function splitStoreEntriesBySegment(
  entries: StoreEntry[],
  query: string
): Record<StoreSegment, StoreEntry[]> {
  const shelves: Record<StoreSegment, StoreEntry[]> = { business: [], software: [] }
  for (const entry of entries) {
    if (matchesStoreQuery(entry, query)) {
      shelves[entry.segment].push(entry)
    }
  }
  return shelves
}
