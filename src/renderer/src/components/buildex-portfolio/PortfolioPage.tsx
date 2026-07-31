import React from 'react'
import { Building2, Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import PortfolioTable, { type PortfolioTarget } from './PortfolioTable'
import type { PortfolioCompany } from './portfolio-row'
import { usePortfolio } from './use-portfolio'

// One screen over N businesses.
//
// Every other BuildEx surface is keyed to one repo, so overseeing several
// companies meant opening each of them in turn to find out which one needed
// something. This is that same per-repo data, read once per business — and
// nothing else: it changes nothing, because a dashboard that acts on six
// companies at once is how an operator breaks five of them by accident.

export default function PortfolioPage(): React.JSX.Element {
  useTranslation()
  const { companies, loading, refresh } = usePortfolio()
  // Read per render, never on a timer: "2h ago" does not need to tick.
  const now = Date.now()

  const open = (company: PortfolioCompany, target: PortfolioTarget): void => {
    if (!company.worktreeId) {
      return
    }
    // Activated first: every per-repo surface reads the active workspace, so
    // opening one without switching would show another business's brain.
    activateAndRevealWorktree(company.worktreeId)
    const store = useAppStore.getState()
    if (target === 'brain') {
      store.openBrainPage()
    } else if (target === 'store') {
      store.openStorePage()
    } else {
      store.openAutomationsPage()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Building2 size={16} className="text-muted-foreground" />
        <h1 className="flex-1 text-[14px] font-semibold tracking-tight">
          {translate('buildex.portfolio.page.title', 'Portfolio')}
        </h1>
        {loading ? <Loader2 size={13} className="animate-spin text-muted-foreground" /> : null}
        <button
          type="button"
          aria-label={translate('buildex.portfolio.page.refresh', 'Refresh')}
          onClick={refresh}
          disabled={loading}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw size={12} />
        </button>
      </header>

      {companies.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          {loading ? (
            <Loader2 size={16} className="animate-spin text-muted-foreground/50" />
          ) : (
            <>
              <Building2 size={22} className="text-muted-foreground/40" />
              <p className="text-[13px] text-muted-foreground">
                {translate('buildex.portfolio.empty.title', 'No businesses yet')}
              </p>
              <p className="max-w-sm text-[12px] text-muted-foreground/70">
                {translate(
                  'buildex.portfolio.empty.hint',
                  'A repo becomes a business when you set up its company brain. Open Brain in a project to start one.'
                )}
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
          <PortfolioTable companies={companies} now={now} onOpen={open} />
          {/* Why: the numbers above are a reading, and a reading has a moment.
              Saying which one keeps "0 unsaved" from reading as a promise. */}
          <p className="max-w-5xl px-4 py-3 text-[11px] text-muted-foreground/70">
            {companies.length === 1
              ? translate(
                  'buildex.portfolio.footer.one',
                  'One business. Read-only — every cell opens the surface it summarises.'
                )
              : translate(
                  'buildex.portfolio.footer.many',
                  '{{value0}} businesses. Read-only — every cell opens the surface it summarises.',
                  { value0: String(companies.length) }
                )}
          </p>
        </div>
      )}
    </div>
  )
}
