import React from 'react'
import { Badge } from '@/components/ui/badge'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  formatAutomationRelativeTime,
  getAutomationRunStatusLabel,
  getAutomationRunStatusVariant
} from '../automations/automation-page-parts'
import type { PortfolioBrainPlacement, PortfolioCompany } from './portfolio-row'

// One row per business, six cells, every one of them a way into the surface it
// summarises. The Portfolio answers "which of my companies needs me today" and
// then gets out of the way — it owns no action of its own.

/** Where each cell goes when it is followed. */
export type PortfolioTarget = 'brain' | 'automations' | 'store'

const GRID =
  'grid grid-cols-[minmax(9rem,1.5fr)_minmax(7rem,1fr)_4.5rem_minmax(8.5rem,1.1fr)_4.5rem_minmax(7rem,1fr)] items-center gap-3 px-4'

function placementLabel(placement: PortfolioBrainPlacement): string {
  switch (placement) {
    case 'in-repo':
      return translate('buildex.portfolio.placement.inRepo', 'In repo')
    case 'separate-repo':
      return translate('buildex.portfolio.placement.separateRepo', 'Own repo')
    case 'shared':
      return translate('buildex.portfolio.placement.shared', 'Shared')
    case 'not-cloned':
      return translate('buildex.portfolio.placement.notCloned', 'Not cloned here')
    case 'missing':
      return translate('buildex.portfolio.placement.missing', 'Brain missing')
    case 'not-a-repo':
      return translate('buildex.portfolio.placement.notARepo', 'Not a git repo')
  }
}

/** A placement the operator has to act on before this brain works here. */
function placementNeedsAttention(placement: PortfolioBrainPlacement): boolean {
  return placement === 'not-cloned' || placement === 'missing' || placement === 'not-a-repo'
}

function Cell({
  onOpen,
  align,
  label,
  children
}: {
  onOpen: (() => void) | null
  align?: 'right'
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  const content = (
    <span className={cn('block min-w-0 truncate', align === 'right' && 'text-right')}>
      {children}
    </span>
  )
  // Why titled rather than merely dimmed: a grey cell reads as "nothing here",
  // and the truth is "BuildEx cannot route you there", which the operator can
  // act on by opening the project once from the sidebar.
  if (!onOpen) {
    return (
      <span
        className="min-w-0 text-muted-foreground/60"
        title={translate(
          'buildex.portfolio.unroutable',
          'No workspace loaded for this business yet — open it once from the sidebar.'
        )}
      >
        {content}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className={cn(
        'min-w-0 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        align === 'right' && 'text-right'
      )}
    >
      {content}
    </button>
  )
}

function DegradedNote({ company }: { company: PortfolioCompany }): React.JSX.Element {
  const text =
    company.degraded === 'remote-host'
      ? translate(
          'buildex.portfolio.degraded.remote',
          'On a remote host — open this business to read its brain there.'
        )
      : translate(
          'buildex.portfolio.degraded.unreadable',
          'BuildEx could not read this brain just now.'
        )
  return <span className="col-span-5 truncate text-[12px] text-muted-foreground">{text}</span>
}

function CompanyRow({
  company,
  now,
  onOpen
}: {
  company: PortfolioCompany
  now: number
  onOpen: (company: PortfolioCompany, target: PortfolioTarget) => void
}): React.JSX.Element {
  const reachable = company.worktreeId !== null
  const open = (target: PortfolioTarget): (() => void) | null =>
    reachable ? () => onOpen(company, target) : null
  const dash = <span className="text-muted-foreground/50">—</span>
  // Named per business, not per column: six identically-labelled buttons on
  // every row is a screen reader reading "open brain" thirty times.
  const label = (key: string, text: string): string =>
    translate(key, text, { value0: company.name })

  return (
    <div className={cn(GRID, 'py-2 text-[13px] transition-colors hover:bg-accent/40')}>
      <Cell
        onOpen={open('brain')}
        label={label('buildex.portfolio.open.company', 'Open {{value0}}')}
      >
        <RepoBadgeLabel name={company.name} color={company.badgeColor} className="font-medium" />
      </Cell>

      {company.degraded ? (
        <DegradedNote company={company} />
      ) : (
        <>
          <Cell
            onOpen={open('brain')}
            label={label('buildex.portfolio.open.brain', '{{value0}} brain')}
          >
            {!company.loaded ? (
              <span className="text-muted-foreground/50">…</span>
            ) : !company.initialized ? (
              <span className="text-muted-foreground">
                {translate('buildex.portfolio.brain.notSetUp', 'Not set up')}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {translate(
                  'buildex.portfolio.brain.summary',
                  '{{value0}} docs · {{value1}}/{{value2}} sections',
                  {
                    value0: String(company.brain?.documentCount ?? 0),
                    value1: String(company.brain?.sectionsFilled ?? 0),
                    value2: String(company.brain?.sectionsTotal ?? 0)
                  }
                )}
              </span>
            )}
          </Cell>

          <Cell
            onOpen={open('brain')}
            align="right"
            label={label('buildex.portfolio.open.unsaved', '{{value0}} unsaved documents')}
          >
            {company.unsavedCount === null ? (
              dash
            ) : company.unsavedCount > 0 ? (
              <span className="font-medium">{company.unsavedCount}</span>
            ) : (
              dash
            )}
          </Cell>

          <Cell
            onOpen={open('automations')}
            label={label('buildex.portfolio.open.automations', '{{value0}} automations')}
          >
            {company.lastRun ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-muted-foreground">
                      {formatAutomationRelativeTime(company.lastRun.at, now) ??
                        translate('buildex.portfolio.run.never', 'Never')}
                    </span>
                    <Badge variant={getAutomationRunStatusVariant(company.lastRun.status)}>
                      {getAutomationRunStatusLabel(company.lastRun.status)}
                    </Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {company.lastRun.automationName}
                </TooltipContent>
              </Tooltip>
            ) : (
              dash
            )}
          </Cell>

          <Cell
            onOpen={open('store')}
            align="right"
            label={label('buildex.portfolio.open.store', '{{value0}} apps')}
          >
            {company.rosterGaps === null ? (
              dash
            ) : company.rosterGaps > 0 ? (
              <span className="font-medium text-destructive">{company.rosterGaps}</span>
            ) : (
              dash
            )}
          </Cell>

          <Cell
            onOpen={open('brain')}
            label={label('buildex.portfolio.open.brainRepo', '{{value0}} brain location')}
          >
            {company.placement ? (
              <span
                className={cn(
                  placementNeedsAttention(company.placement)
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                )}
              >
                {placementLabel(company.placement)}
              </span>
            ) : (
              dash
            )}
          </Cell>
        </>
      )}
    </div>
  )
}

export default function PortfolioTable({
  companies,
  now,
  onOpen
}: {
  companies: PortfolioCompany[]
  now: number
  onOpen: (company: PortfolioCompany, target: PortfolioTarget) => void
}): React.JSX.Element {
  // Capped rather than fluid: six columns stretched across a 27" display put
  // "3 unsaved" a hand's width from the business it belongs to.
  return (
    <div className="min-w-0 max-w-5xl">
      <div
        className={cn(
          GRID,
          'border-b border-border py-1.5 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase'
        )}
      >
        <span>{translate('buildex.portfolio.column.business', 'Business')}</span>
        <span>{translate('buildex.portfolio.column.brain', 'Brain')}</span>
        <span className="text-right">
          {translate('buildex.portfolio.column.unsaved', 'Unsaved')}
        </span>
        <span>{translate('buildex.portfolio.column.lastRun', 'Last run')}</span>
        <span className="text-right">{translate('buildex.portfolio.column.apps', 'Apps')}</span>
        <span>{translate('buildex.portfolio.column.brainRepo', 'Brain repo')}</span>
      </div>
      <div className="divide-y divide-border/50">
        {companies.map((company) => (
          <CompanyRow key={company.repoId} company={company} now={now} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}
