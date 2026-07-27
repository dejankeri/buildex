import React, { useEffect, useState } from 'react'
import { Check, Loader2, ShieldCheck, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { BuildExPack } from '../../../../shared/buildex-packs-types'
import { usePackCatalog } from './use-pack-catalog'

// The app store: capability packs a company installs into its own repo.
// Installing writes skills into the repo, so `git status` shows exactly what the
// company gained and reverting is a checkout — git stays the record.

export default function StorePage(): React.JSX.Element {
  useTranslation()
  const { catalog, repoPath, loading, refresh } = usePackCatalog()
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [gateRuleCount, setGateRuleCount] = useState<number | null>(null)

  // The gate belongs next to the Store: installing a capability and deciding
  // which of its actions wait for a person are the same question asked twice.
  useEffect(() => {
    let cancelled = false
    if (!repoPath) {
      setGateRuleCount(null)
      return
    }
    void window.api.buildexGate.sync({ repoPath }).then((result) => {
      if (!cancelled) {
        setGateRuleCount(result.preset.ask.length + result.preset.deny.length)
      }
    })
    return () => {
      cancelled = true
    }
  }, [repoPath])

  const install = async (pack: BuildExPack): Promise<void> => {
    if (!repoPath) {
      return
    }
    setInstallingId(pack.id)
    setError(null)
    setNotice(null)
    try {
      const result = await window.api.buildexPacks.install({ repoPath, packId: pack.id })
      if (!result.ok) {
        setError(result.error ?? 'Install failed')
      } else if (result.keptOperatorEdits.length > 0) {
        // Why: silently skipping a file the operator wrote would look like the
        // install worked and the pack simply behaves differently. Say it.
        setNotice(
          translate(
            'buildex.store.page.keptEdits',
            'Kept your edited files, so {{value0}} was not fully replaced: {{value1}}',
            { value0: pack.name, value1: result.keptOperatorEdits.join(', ') }
          )
        )
      }
      await refresh()
    } finally {
      setInstallingId(null)
    }
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
        {loading ? <Loader2 size={13} className="animate-spin text-muted-foreground" /> : null}
      </div>

      {error ? (
        <div className="shrink-0 border-b border-border px-4 py-2 text-[12px] text-destructive">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="shrink-0 border-b border-border px-4 py-2 text-[12px] text-muted-foreground">
          {notice}
        </div>
      ) : null}

      {catalog.packs.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <Store size={22} className="text-muted-foreground/40" />
          <p className="text-[13px] text-muted-foreground">
            {translate('buildex.store.page.emptyTitle', 'No packs available yet')}
          </p>
          <p className="max-w-sm text-[12px] text-muted-foreground/70">
            {translate(
              'buildex.store.page.emptyHint',
              'Skill packs you install are written into your company repo.'
            )}
          </p>
        </div>
      ) : (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {catalog.packs.map((pack) => (
              <div
                key={pack.id}
                className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-xs"
              >
                <div className="flex items-start gap-2">
                  <span className="text-[18px] leading-none">{pack.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{pack.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {pack.skills.length} {translate('buildex.store.page.skills', 'skills')}
                    </div>
                  </div>
                </div>
                <p className="line-clamp-3 min-h-[2.5rem] text-[12px] text-muted-foreground">
                  {pack.summary}
                </p>
                <button
                  type="button"
                  aria-label={`${
                    pack.installed
                      ? translate('buildex.store.page.installed', 'Installed')
                      : translate('buildex.store.page.install', 'Install')
                  } ${pack.name}`}
                  disabled={pack.installed || installingId === pack.id || !repoPath}
                  onClick={() => void install(pack)}
                  className={cn(
                    'inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-[12px] font-medium transition-colors',
                    pack.installed
                      ? 'text-muted-foreground'
                      : 'bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50'
                  )}
                >
                  {pack.installed ? (
                    <>
                      <Check size={12} />
                      {translate('buildex.store.page.installed', 'Installed')}
                    </>
                  ) : installingId === pack.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    translate('buildex.store.page.install', 'Install')
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
