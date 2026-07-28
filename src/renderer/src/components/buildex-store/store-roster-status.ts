import type {
  StoreCatalog,
  StoreEntry,
  StoreRosterEntry
} from '../../../../shared/buildex-store-types'
import { storeEntryKey } from './store-entry-search'

// What the company's roster means for *this* machine.
//
// The roster travels with the clone; the installs do not. So the only useful
// reading of it is the difference between the two, which is what the Store shows
// a teammate on their first open.

export type StoreRosterStatus = {
  /** Repo-relative file to commit, so the page can name it. */
  path: string
  expected: number
  requiredCount: number
  suggestedCount: number
  /** Rostered apps this machine does not have, in the catalog's own order. */
  missing: StoreEntry[]
  /** Rostered apps no marketplace the Store reads carries any more. */
  unavailable: StoreRosterEntry[]
}

export function resolveRosterStatus(catalog: StoreCatalog): StoreRosterStatus | null {
  const roster = catalog.roster
  if (!roster || roster.entries.length === 0) {
    return null
  }

  const rosterKeys = new Set(
    roster.entries.map((line) => `${line.marketplaceId}/${line.pluginName}`)
  )
  const matchedKeys = new Set<string>()
  const missing: StoreEntry[] = []

  // Why: walking the catalog rather than the roster keeps the sort main already
  // applied — required first — instead of the file's arbitrary order.
  for (const entry of catalog.entries) {
    const key = storeEntryKey(entry)
    if (!rosterKeys.has(key)) {
      continue
    }
    matchedKeys.add(key)
    if (!entry.installed) {
      missing.push(entry)
    }
  }

  return {
    path: roster.path,
    expected: roster.entries.length,
    requiredCount: roster.entries.filter((line) => line.requirement === 'required').length,
    suggestedCount: roster.entries.filter((line) => line.requirement === 'suggested').length,
    missing,
    unavailable: roster.entries.filter(
      (line) => !matchedKeys.has(`${line.marketplaceId}/${line.pluginName}`)
    )
  }
}
