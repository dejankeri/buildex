import React, { useMemo, useRef, useState } from 'react'
import { Briefcase, Code2, Loader2, RefreshCw, Search, ShieldCheck, Store, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type {
  StoreEntry,
  StoreRequirement,
  StoreSegment
} from '../../../../shared/buildex-store-types'
import StoreNotices from './StoreNotices'
import StoreRosterBanner from './StoreRosterBanner'
import StoreShelf from './StoreShelf'
import UngatedInstallDialog from './UngatedInstallDialog'
import { splitStoreEntriesBySegment, storeEntryKey } from './store-entry-search'
import { resolveRosterStatus } from './store-roster-status'
import { useRosterBulkInstall } from './use-roster-bulk-install'
import { useStoreCatalog } from './use-store-catalog'
import { useStoreWorkspaceNotices } from './use-store-workspace-notices'

// The Store: a client of the plugin marketplaces each coding agent already has.
//
// Two shelves, because they are two products for two people — someone running a
// business and someone building software — and the same app can honestly sit on
// both. Installing is the agent's own plugin mechanism; what BuildEx adds is the
// ask-first gate, the credential, and the company-context line, and it adds them
// only where it has an overlay. Everything else installs ungated and says so.
//
// The one shared thing is the roster: which apps the company expects. It is a
// git-tracked file in the brain, so it is the only part of the Store a teammate
// inherits by cloning.

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
  const [segment, setSegment] = useState<StoreSegment>('business')
  const [query, setQuery] = useState('')
  const [busyEntryKey, setBusyEntryKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingUngated, setPendingUngated] = useState<StoreEntry | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const bulk = useRosterBulkInstall(repoPath, refresh)

  const shelves = useMemo(
    () => splitStoreEntriesBySegment(catalog.entries, query),
    [catalog.entries, query]
  )
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

      <Tabs
        value={segment}
        onValueChange={(next) => setSegment(next as StoreSegment)}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2">
          <TabsList>
            <TabsTrigger value="business" className="text-[13px]">
              <Briefcase />
              {translate('buildex.store.segment.business', 'Run your business')}
              <span className="text-muted-foreground">{shelves.business.length}</span>
            </TabsTrigger>
            <TabsTrigger value="software" className="text-[13px]">
              <Code2 />
              {translate('buildex.store.segment.software', 'Build software')}
              <span className="text-muted-foreground">{shelves.software.length}</span>
            </TabsTrigger>
          </TabsList>

          {/* Why: hundreds of plugins per shelf, so search is the way through and
              gets the focus the moment the page opens. */}
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

        {(['business', 'software'] as StoreSegment[]).map((value) => (
          <TabsContent key={value} value={value} className="flex min-h-0 flex-col">
            <StoreShelf
              entries={shelves[value]}
              header={
                value === 'business' && rosterStatus ? (
                  <StoreRosterBanner
                    status={rosterStatus}
                    bulk={bulk}
                    installDisabled={installDisabled}
                    onInstallAll={(missing) => void bulk.run(missing)}
                  />
                ) : null
              }
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
          </TabsContent>
        ))}
      </Tabs>

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
