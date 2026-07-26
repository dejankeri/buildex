import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Brain, FileText, Link2, RefreshCw, Unlink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useActiveWorktree } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { BrainScan } from '../../../../shared/buildex-brain-types'
import { EMPTY_BRAIN_SCAN } from '../../../../shared/buildex-brain-types'
import { RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME } from './right-sidebar-titlebar-drag-regions'
import { buildBrainRows, filterDocuments, summarizeScan } from './brain-panel-rows'

// The company brain: a deterministic map of the company repo — every markdown
// document, how they link to each other, and what is not yet committed. Rendered
// entirely from files on disk with no model in the loop (BuildEx invariant 9).

export default function BrainPanel(): React.JSX.Element {
  // Why: renders under the right sidebar's memo boundary, so it needs its own
  // language subscription to re-render on locale change.
  useTranslation()
  const activeWorktree = useActiveWorktree()
  const repoPath = activeWorktree?.path ?? null

  const [scan, setScan] = useState<BrainScan>(EMPTY_BRAIN_SCAN)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')

  const runScan = useCallback(async (): Promise<void> => {
    if (!repoPath) {
      setScan(EMPTY_BRAIN_SCAN)
      return
    }
    setLoading(true)
    try {
      setScan(await window.api.buildexBrain.scan({ repoPath }))
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  useEffect(() => {
    let cancelled = false
    // Why: a slow scan on a large repo must not overwrite a newer workspace's
    // results if the operator switches worktrees mid-flight.
    void (async () => {
      if (!repoPath) {
        setScan(EMPTY_BRAIN_SCAN)
        return
      }
      setLoading(true)
      try {
        const next = await window.api.buildexBrain.scan({ repoPath })
        if (!cancelled) {
          setScan(next)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repoPath])

  const summary = useMemo(() => summarizeScan(scan), [scan])
  const rows = useMemo(
    () => buildBrainRows(filterDocuments(scan.documents, query)),
    [scan.documents, query]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className={cn(
          'flex h-[36px] shrink-0 items-center gap-2 border-b border-border px-3',
          RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME
        )}
      >
        <Brain size={14} className="text-muted-foreground" />
        <span className="flex-1 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {translate('buildex.brain.panel.title', 'Company Brain')}
        </span>
        <button
          type="button"
          onClick={() => void runScan()}
          disabled={!repoPath || loading}
          aria-label={translate('buildex.brain.panel.rescan', 'Rescan company brain')}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-muted-foreground disabled:opacity-40"
        >
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      {!repoPath ? (
        <BrainEmptyState
          title={translate('buildex.brain.panel.emptyTitle', 'No company repo connected')}
          hint={translate(
            'buildex.brain.panel.emptyHint',
            'Open a company repo to see its map, history, and decisions.'
          )}
        />
      ) : scan.documents.length === 0 && !loading ? (
        <BrainEmptyState
          title={translate('buildex.brain.panel.noDocsTitle', 'No documents yet')}
          hint={translate(
            'buildex.brain.panel.noDocsHint',
            'The company brain is built from markdown files in this repo.'
          )}
        />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <FileText size={11} />
              {summary.documentCount}
            </span>
            <span className="inline-flex items-center gap-1">
              <Link2 size={11} />
              {summary.linkCount}
            </span>
            {summary.orphanCount > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Unlink size={11} />
                {summary.orphanCount}
              </span>
            ) : null}
            {summary.changedCount > 0 ? (
              <span className="ml-auto text-amber-500">
                {summary.changedCount} {translate('buildex.brain.panel.unsaved', 'unsaved')}
              </span>
            ) : null}
          </div>

          <div className="shrink-0 px-2 py-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={translate('buildex.brain.panel.filter', 'Filter documents')}
              className="h-7 w-full rounded-md border border-border bg-input px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {rows.map((row) =>
              row.kind === 'folder' ? (
                <div
                  key={row.key}
                  className="px-2 pt-3 pb-1 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground/70 uppercase"
                >
                  {row.label}
                  <span className="ml-1 font-normal text-muted-foreground/40">
                    {row.documentCount}
                  </span>
                </div>
              ) : (
                <div
                  key={row.key}
                  title={row.document.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate">{row.document.name}</span>
                  {row.document.changed ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
                  ) : null}
                  {row.document.linksTo.length + row.document.linkedFrom.length > 0 ? (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
                      {row.document.linksTo.length + row.document.linkedFrom.length}
                    </span>
                  ) : null}
                </div>
              )
            )}
          </div>
        </>
      )}
    </div>
  )
}

function BrainEmptyState({ title, hint }: { title: string; hint: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <Brain size={20} className="text-muted-foreground/40" />
      <p className="text-[13px] text-muted-foreground">{title}</p>
      <p className="text-[12px] text-muted-foreground/70">{hint}</p>
    </div>
  )
}
