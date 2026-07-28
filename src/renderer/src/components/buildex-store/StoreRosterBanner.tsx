import React from 'react'
import { Building2, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type { StoreEntry } from '../../../../shared/buildex-store-types'
import type { RosterBulkInstall } from './use-roster-bulk-install'
import type { StoreRosterStatus } from './store-roster-status'

// What the company runs on, at the top of the shelf a teammate opens first.
//
// A summary and one action, not a second copy of the cards: the rostered apps
// already lead the grid below, so repeating them here would make the same app
// answer to two Install buttons.

export default function StoreRosterBanner({
  status,
  bulk,
  installDisabled,
  onInstallAll
}: {
  status: StoreRosterStatus
  bulk: RosterBulkInstall
  installDisabled: boolean
  onInstallAll: (entries: StoreEntry[]) => void
}): React.JSX.Element {
  const missingCount = status.missing.length

  return (
    <div className="mb-3 flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Building2 className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="flex-1 text-[13px] font-medium">
          {translate('buildex.store.roster.title', 'What your company runs on')}
        </h2>
        {missingCount > 0 ? (
          <Button
            size="xs"
            disabled={installDisabled || bulk.running}
            onClick={() => onInstallAll(status.missing)}
          >
            {bulk.running ? <Loader2 className="animate-spin" /> : null}
            {translate('buildex.store.roster.installAll', 'Install all {{value0}}', {
              value0: String(missingCount)
            })}
          </Button>
        ) : null}
      </div>

      <p className="text-[12px] text-muted-foreground">
        {translate('buildex.store.roster.counts', '{{value0}} required · {{value1}} suggested', {
          value0: String(status.requiredCount),
          value1: String(status.suggestedCount)
        })}
        {' · '}
        {missingCount > 0
          ? translate('buildex.store.roster.missing', '{{value0}} not installed here', {
              value0: String(missingCount)
            })
          : translate('buildex.store.roster.allInstalled', 'all installed here')}
      </p>

      {/* Why: a run of shell-outs is minutes long, so it names the app in flight
          rather than spinning anonymously. */}
      {bulk.running && bulk.currentName ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'buildex.store.roster.progress',
            'Installing {{value0}} — {{value1}} of {{value2}}',
            {
              value0: bulk.currentName,
              value1: String(bulk.done + 1),
              value2: String(bulk.total)
            }
          )}
        </p>
      ) : null}

      {!bulk.running && bulk.failures.length > 0 ? (
        <p className="text-[11px] text-destructive">
          {translate('buildex.store.roster.failures', 'Could not install: {{value0}}', {
            value0: bulk.failures.join(', ')
          })}
        </p>
      ) : null}

      {status.unavailable.length > 0 ? (
        <p className="text-[11px] text-muted-foreground/70">
          {translate(
            'buildex.store.roster.unavailable',
            '{{value0}} on the list is not in any marketplace this workspace reads.',
            { value0: String(status.unavailable.length) }
          )}
        </p>
      ) : null}

      <p className="text-[11px] text-muted-foreground/70">
        {translate(
          'buildex.store.roster.sharedVia',
          'This list lives in {{value0}} and travels with a clone. The apps themselves stay per-machine.',
          { value0: status.path }
        )}
      </p>
    </div>
  )
}
