import type { StoreEntry } from '../../../../shared/buildex-store-types'

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

/** The shelf as the query leaves it, in the order main already sorted it. */
export function filterStoreEntries(entries: StoreEntry[], query: string): StoreEntry[] {
  return entries.filter((entry) => matchesStoreQuery(entry, query))
}
