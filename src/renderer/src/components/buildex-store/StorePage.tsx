import React, { useMemo, useRef, useState } from 'react'
import { Library, Loader2, RefreshCw, Search, ShieldCheck, Store, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Input } from '@/components/ui/input'
import type { StoreEntry, StoreRequirement } from '../../../../shared/buildex-store-types'
import StoreMarketplacesDialog from './StoreMarketplacesDialog'
import StoreNotices from './StoreNotices'
import StoreRosterBanner from './StoreRosterBanner'
import StoreShelf from './StoreShelf'
import UngatedInstallDialog from './UngatedInstallDialog'
import { filterStoreEntries, storeEntryKey } from './store-entry-search'
import { resolveRosterStatus } from './store-roster-status'
import { useCompanyMarketplaces } from './use-company-marketplaces'
import { useRosterBulkInstall } from './use-roster-bulk-install'
import { useStoreCatalog } from './use-store-catalog'
import { useStoreWorkspaceNotices } from './use-store-workspace-notices'

// The Store: a client of the plugin marketplaces each coding agent already has.
//
// One shelf. The split into "run your business" and "build software" was two
// products for two people, and there is one person here running N businesses —
// it cost a tab click and an is-it-on-the-other-shelf doubt to say something the
// card's own badge says better. The segment survives as the shelf's order, so an
// operator still meets business apps before dev tooling.
//
// Installing is the agent's own plugin mechanism; what BuildEx adds is the
// ask-first gate, the credential, and the company-context line, and it adds them
// only where it has an overlay. Everything else installs ungated and says so.
//
// The roster leads the page, above the search: it is the one shared thing — a
// git-tracked file in the brain — so a teammate who has just cloned should be
// one click from having the company's apps, with browsing underneath it.

export default function StorePage(): React.JSX.Element {
  useTranslation()
  const {
    catalog,
    repoPath,
    loading,
    refreshingIndexes,
    error: catalogError,
    refresh,
    refreshIndexes
  } = useStoreCatalog()
  const { gateRuleCount, sharedBrain } = useStoreWorkspaceNotices(repoPath)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [busyEntryKey, setBusyEntryKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingUngated, setPendingUngated] = useState<StoreEntry | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [marketplacesOpen, setMarketplacesOpen] = useState(false)
  const bulk = useRosterBulkInstall(repoPath, refresh)
  const marketplaces = useCompanyMarketplaces(repoPath, refresh)

  const shelf = useMemo(() => filterStoreEntries(catalog.entries, query), [catalog.entries, query])
  const rosterStatus = useMemo(() => resolveRosterStatus(catalog), [catalog])

  // Installing is delegated, so an agent with no plugin system BuildEx can drive
  // leaves the shelves browsable and the buttons off.
  const installDisabled = !repoPath || catalog.unsupportedAgent !== null || bulk.running

  const runInstall = async (entry: StoreEntry, mode: 'install' | 'uninstall'): Promise<void> => {
    if (!repoPath) {
      return
    }
    setBusyEntryKey(storeEntryKey(entry))
    setActionError(null)
    setNotice(null)
    try {
      const request = {
        repoPath,
        marketplaceId: entry.marketplaceId,
        pluginName: entry.plugin.name
      }
      const result =
        mode === 'install'
          ? await window.api.buildexStore.install(request)
          : await window.api.buildexStore.uninstall(request)
      if (!result.ok) {
        // Why: the agent's CLI output is the only account of what went wrong, so
        // it is shown rather than replaced with a generic failure line.
        setActionError(result.error ?? result.output ?? 'The agent could not complete that.')
      }
      await refresh()
    } finally {
      setBusyEntryKey(null)
    }
  }

  const onInstall = (entry: StoreEntry): void => {
    if (entry.curated) {
      void runInstall(entry, 'install')
      return
    }
    setPendingUngated(entry)
  }

  // Why: writing the roster edits a tracked file. Nothing is shared until that
  // file is committed, so the page says which one rather than implying the
  // teammate already has it.
  const setRequirement = async (
    entry: StoreEntry,
    requirement: StoreRequirement | null
  ): Promise<void> => {
    if (!repoPath) {
      return
    }
    setActionError(null)
    setNotice(null)
    const result = await window.api.buildexStore.setRosterEntry({
      repoPath,
      pluginName: entry.plugin.name,
      marketplaceId: entry.marketplaceId,
      requirement
    })
    if (!result.ok) {
      setActionError(result.error ?? 'Could not update the company app list.')
      return
    }
    setNotice(
      translate(
        'buildex.store.roster.committed',
        'Updated {{value0}} — commit it to share this list with your team.',
        { value0: result.roster?.path ?? rosterStatus?.path ?? '' }
      )
    )
    await refresh()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Store size={16} className="text-muted-foreground" />
        <h1 className="flex-1 text-[14px] font-semibold tracking-tight">
          {translate('buildex.store.page.title', 'Store')}
        </h1>
        {gateRuleCount !== null ? (
          <span
            className="flex items-center gap-1 text-[11px] text-muted-foreground"
            title={translate(
              'buildex.store.page.gateHint',
              'The agent works on its own, except for these — they wait for you.'
            )}
          >
            <ShieldCheck size={12} />
            {translate('buildex.store.page.gate', '{{value0}} actions ask first', {
              value0: String(gateRuleCount)
            })}
          </span>
        ) : null}
        {/* Why here: which marketplaces this company reads is the question behind
            everything on the shelf, so it belongs next to the shelf and not in a
            settings page two levels away. */}
        <button
          type="button"
          aria-label={translate('buildex.store.marketplaces.open', 'Marketplaces')}
          title={translate(
            'buildex.store.marketplaces.openHint',
            'Choose where this company’s apps come from.'
          )}
          onClick={() => setMarketplacesOpen(true)}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent"
        >
          <Library size={12} />
        </button>
        {/* Why: indexes are fetched, not bundled, so the operator needs a way to
            go and get them now rather than waiting for the cache to age out. */}
        <button
          type="button"
          aria-label={translate('buildex.store.page.refreshIndexes', 'Refresh apps')}
          title={translate(
            'buildex.store.page.refreshIndexesHint',
            'Fetch the latest apps from the marketplaces.'
          )}
          disabled={refreshingIndexes}
          onClick={() => void refreshIndexes()}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshingIndexes ? 'animate-spin' : undefined} />
        </button>
        {loading && !refreshingIndexes ? (
          <Loader2 size={13} className="animate-spin text-muted-foreground" />
        ) : null}
      </div>

      <StoreNotices
        error={actionError ?? catalogError}
        notice={notice}
        repoPath={repoPath}
        sharedBrain={sharedBrain}
        unsupportedAgent={catalog.unsupportedAgent}
      />

      {/* Why above the search: on a fresh clone the company's own apps are the
          reason the page was opened, and browsing 276 plugins is not. */}
      {rosterStatus ? (
        <StoreRosterBanner
          status={rosterStatus}
          bulk={bulk}
          installDisabled={installDisabled}
          onInstallAll={(missing) => void bulk.run(missing)}
        />
      ) : null}

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2">
        <span className="text-[12px] text-muted-foreground">
          {translate('buildex.store.page.count', '{{value0}} apps', {
            value0: String(shelf.length)
          })}
        </span>

        {/* Why: hundreds of plugins on the shelf, so search is the way through
            and gets the focus the moment the page opens. */}
        <div className="relative ml-auto w-full min-w-[200px] sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            autoFocus
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation()
                setQuery('')
              }
            }}
            placeholder={translate('buildex.store.page.search', 'Search apps')}
            aria-label={translate('buildex.store.page.searchLabel', 'Search apps')}
            className="h-8 pr-8 pl-8 text-[13px]"
          />
          {query ? (
            <button
              type="button"
              aria-label={translate('buildex.store.page.clearSearch', 'Clear search')}
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <StoreShelf
        entries={shelf}
        query={query}
        catalogEmpty={catalog.entries.length === 0}
        fetchingIndexes={refreshingIndexes}
        worktreeId={activeWorktreeId}
        busyEntryKey={busyEntryKey}
        installDisabled={installDisabled}
        rosterDisabled={!repoPath || bulk.running}
        onInstall={onInstall}
        onUninstall={(entry) => void runInstall(entry, 'uninstall')}
        onSetRequirement={(entry, requirement) => void setRequirement(entry, requirement)}
        onChanged={refresh}
      />

      <StoreMarketplacesDialog
        open={marketplacesOpen}
        onOpenChange={(next) => {
          setMarketplacesOpen(next)
          if (!next) {
            marketplaces.clearError()
          }
        }}
        marketplaces={catalog.marketplaces}
        marketplacesPath={catalog.marketplacesPath}
        repoPath={repoPath}
        onAdd={marketplaces.add}
        onRemove={marketplaces.remove}
        busy={marketplaces.busy}
        error={marketplaces.error}
      />

      <UngatedInstallDialog
        entry={pendingUngated}
        onCancel={() => setPendingUngated(null)}
        onConfirm={(entry) => {
          setPendingUngated(null)
          void runInstall(entry, 'install')
        }}
      />
    </div>
  )
}
