import React from 'react'
import { Loader2, SearchX, Store } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { StoreEntry, StoreRequirement } from '../../../../shared/buildex-store-types'
import StoreEntryCard from './StoreEntryCard'
import { storeEntryKey } from './store-entry-search'

// The shelf, plus the two ways it can be empty: the indexes never loaded, or the
// search matched nothing. They need different copy — the first is a failure, the
// second is a normal search.

export default function StoreShelf({
  entries,
  query,
  catalogEmpty,
  fetchingIndexes,
  worktreeId,
  busyEntryKey,
  installDisabled,
  rosterDisabled,
  onInstall,
  onUninstall,
  onSetRequirement,
  onChanged
}: {
  entries: StoreEntry[]
  query: string
  catalogEmpty: boolean
  /** True while the indexes are being fetched for the first time. */
  fetchingIndexes: boolean
  worktreeId: string | null
  busyEntryKey: string | null
  installDisabled: boolean
  rosterDisabled: boolean
  onInstall: (entry: StoreEntry) => void
  onUninstall: (entry: StoreEntry) => void
  onSetRequirement: (entry: StoreEntry, requirement: StoreRequirement | null) => void
  onChanged: () => void | Promise<void>
}): React.JSX.Element {
  if (catalogEmpty) {
    // Why: an empty shelf on a fresh machine is the normal first second, not a
    // failure. Saying "no marketplaces" while the fetch is in flight would be
    // wrong, and it is the state most people see first.
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        {fetchingIndexes ? (
          <Loader2 className="size-7 animate-spin text-muted-foreground/40" />
        ) : (
          <Store className="size-7 text-muted-foreground/40" />
        )}
        <p className="text-[13px] text-muted-foreground">
          {fetchingIndexes
            ? translate('buildex.store.shelf.fetchingTitle', 'Fetching apps…')
            : translate('buildex.store.shelf.catalogEmptyTitle', 'No apps yet')}
        </p>
        <p className="max-w-sm text-[12px] text-muted-foreground/70">
          {fetchingIndexes
            ? translate(
                'buildex.store.shelf.fetchingHint',
                'Reading the marketplaces for the first time on this machine.'
              )
            : translate(
                'buildex.store.shelf.catalogEmptyHint',
                'The marketplaces could not be reached. Check the connection and refresh — installing needs the network too.'
              )}
        </p>
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <SearchX className="size-7 text-muted-foreground/40" />
        <p className="text-[13px] text-muted-foreground">
          {translate('buildex.store.shelf.noMatches', 'Nothing matches “{{value0}}”', {
            value0: query
          })}
        </p>
        <p className="max-w-sm text-[12px] text-muted-foreground/70">
          {translate(
            'buildex.store.shelf.noMatchesHint',
            'Search runs over every marketplace this company reads. Add another one to widen it.'
          )}
        </p>
      </div>
    )
  }

  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {entries.map((entry) => (
          <StoreEntryCard
            key={storeEntryKey(entry)}
            entry={entry}
            worktreeId={worktreeId}
            busy={busyEntryKey === storeEntryKey(entry)}
            installDisabled={installDisabled}
            rosterDisabled={rosterDisabled}
            onInstall={onInstall}
            onUninstall={onUninstall}
            onSetRequirement={onSetRequirement}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  )
}
