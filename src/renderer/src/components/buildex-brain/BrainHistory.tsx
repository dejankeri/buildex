import React, { useState } from 'react'
import { ChevronDown, ChevronRight, GitCommitVertical, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { BrainHistoryResult } from '../../../../shared/buildex-brain-types'
import BrainSaveDiff from './BrainSaveDiff'

// The brain's history: `git log -- .buildex/`, rendered.
//
// No parallel record, no LLM — the repo is the source, so what this shows and
// what a teammate sees after a pull cannot drift apart.
//
// A save opens into its own diff rather than the current documents. Scheduled
// runs write here overnight, and "what did that night add" is not a question
// today's version of the file can answer.

/** Nothing to say (embedded, or shared fine), a brain with no remote, or a real failure. */
type ShareState = null | { kind: 'local-only' } | { kind: 'failed'; detail: string }

function shareState(push: { pushed?: boolean; localOnly?: boolean; detail?: string }): ShareState {
  if (push.pushed !== false) {
    // Undefined in embedded mode, where BuildEx never pushes at all.
    return null
  }
  if (push.localOnly) {
    return { kind: 'local-only' }
  }
  return { kind: 'failed', detail: push.detail ?? '' }
}

function relativeTime(unixSeconds: number, now: number): string {
  const seconds = Math.max(0, Math.floor(now / 1000) - unixSeconds)
  const days = Math.floor(seconds / 86400)
  if (days >= 1) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-days, 'day')
  }
  const hours = Math.floor(seconds / 3600)
  if (hours >= 1) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-hours, 'hour')
  }
  const minutes = Math.floor(seconds / 60)
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-minutes, 'minute')
}

export default function BrainHistory({
  history,
  repoPath,
  onSaved,
  onOpenDocument
}: {
  history: BrainHistoryResult
  repoPath: string | null
  onSaved: () => void | Promise<void>
  onOpenDocument: (documentId: string) => void
}): React.JSX.Element {
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Why: a commit that never reached the remote. The writing is safe here, and
  // saying "saved" alone would let an operator believe their team has it. A
  // brain with no remote is its own state, not a failure — nothing went wrong
  // and a retry cannot change it.
  const [share, setShare] = useState<ShareState>(null)
  const [sharing, setSharing] = useState(false)
  const [openHash, setOpenHash] = useState<string | null>(null)
  const now = Date.now()

  const save = async (): Promise<void> => {
    if (!repoPath || !message.trim()) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.buildexBrainSections.save({ repoPath, message })
      if (!result.ok) {
        setError(result.error ?? 'Could not save')
        return
      }
      setMessage('')
      // The save and the push channel name the same thing differently:
      // `pushError` beside a committed save, `error` on a push of its own.
      setShare(
        shareState({
          pushed: result.pushed,
          localOnly: result.localOnly,
          detail: result.pushError
        })
      )
      await onSaved()
    } finally {
      setSaving(false)
    }
  }

  const shareAgain = async (): Promise<void> => {
    if (!repoPath) {
      return
    }
    setSharing(true)
    try {
      const result = await window.api.buildexBrain.push({ repoPath })
      setShare(
        shareState({ pushed: result.pushed, localOnly: result.localOnly, detail: result.error })
      )
    } finally {
      setSharing(false)
    }
  }

  if (history.unavailable) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
        <p className="max-w-sm text-[12px] text-muted-foreground">
          {translate(
            'buildex.brain.history.unavailable',
            'This project has no git history yet, so there is nothing to show and nothing to save into.'
          )}
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-4">
        <ol className="flex flex-col">
          {history.saves.map((save_) => (
            <li key={save_.hash} className="flex gap-3 border-l border-border pl-4">
              <GitCommitVertical
                size={14}
                className="-ml-[1.4rem] mt-0.5 shrink-0 bg-background text-muted-foreground"
              />
              <div className="min-w-0 flex-1 pb-4">
                <button
                  type="button"
                  aria-expanded={openHash === save_.hash}
                  onClick={() => setOpenHash(openHash === save_.hash ? null : save_.hash)}
                  className="flex w-full items-baseline gap-2 rounded-md px-1 py-0.5 text-left hover:bg-accent"
                >
                  {openHash === save_.hash ? (
                    <ChevronDown size={12} className="shrink-0 self-center text-muted-foreground" />
                  ) : (
                    <ChevronRight
                      size={12}
                      className="shrink-0 self-center text-muted-foreground"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {save_.subject}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {relativeTime(save_.timestamp, now)}
                  </span>
                </button>
                <div className="mt-0.5 flex flex-wrap gap-x-2 pl-[1.375rem] text-[11px] text-muted-foreground/70">
                  {save_.changedPaths.map((changedPath) => (
                    <button
                      key={changedPath}
                      type="button"
                      onClick={() => onOpenDocument(changedPath)}
                      className="underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {changedPath}
                    </button>
                  ))}
                </div>
                {openHash === save_.hash ? (
                  <BrainSaveDiff repoPath={repoPath} hash={save_.hash} />
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {history.saves.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            {translate('buildex.brain.history.none', 'No saves yet.')}
          </p>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-border p-3">
        {history.unsavedPaths.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            {translate('buildex.brain.history.clean', 'Everything is saved.')}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-[12px] text-muted-foreground">
              {translate(
                'buildex.brain.history.pending',
                '{{value0}} changed since the last save: {{value1}}',
                {
                  value0: String(history.unsavedPaths.length),
                  value1: history.unsavedPaths.slice(0, 4).join(', ')
                }
              )}
            </p>
            <div className="flex items-center gap-2">
              <input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && message.trim()) {
                    void save()
                  }
                }}
                placeholder={translate(
                  'buildex.brain.history.namePlaceholder',
                  'What changed? e.g. "Q3 pricing and the Northwind call"'
                )}
                className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-[12px] outline-none focus:ring-[3px] focus:ring-ring/50"
              />
              <button
                type="button"
                disabled={saving || !message.trim()}
                onClick={() => void save()}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : null}
                {translate('buildex.brain.history.save', 'Save')}
              </button>
            </div>
            {/* Why: say the scope out loud. In a mixed repo an operator must not
                discover later that this did or did not touch their code. */}
            <p className="text-[11px] text-muted-foreground/60">
              {translate(
                'buildex.brain.history.scope',
                'Saves the .buildex folder only. Nothing else in this project is touched.'
              )}
            </p>
          </div>
        )}
        {share?.kind === 'local-only' ? (
          <p className="mt-2 text-[12px] text-muted-foreground">
            {translate(
              'buildex.brain.history.localOnly',
              'Saved. This brain has no remote yet, so it stays on this machine until it has one.'
            )}
          </p>
        ) : null}
        {share?.kind === 'failed' ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-[12px] text-amber-500">
              {translate(
                'buildex.brain.history.notShared',
                'Saved here, not shared yet — the brain repo did not accept the push.'
              )}
            </p>
            <button
              type="button"
              disabled={sharing}
              onClick={() => void shareAgain()}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium hover:bg-accent disabled:opacity-50"
            >
              {sharing ? <Loader2 size={11} className="animate-spin" /> : null}
              {translate('buildex.brain.history.retryShare', 'Try again')}
            </button>
            {share.detail ? (
              <p className="w-full truncate font-mono text-[11px] text-muted-foreground/60">
                {share.detail}
              </p>
            ) : null}
          </div>
        ) : null}
        {error ? <p className="mt-2 text-[12px] text-destructive">{error}</p> : null}
      </div>
    </div>
  )
}
