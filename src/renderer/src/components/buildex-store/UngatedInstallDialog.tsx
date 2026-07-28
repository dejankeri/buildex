import React from 'react'
import { ExternalLink, ShieldAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { StoreEntry } from '../../../../shared/buildex-store-types'
import { storeEntryDisplayName } from './store-entry-search'
import { describePluginSource, pluginSourceWebUrl } from './store-plugin-provenance'

// The ungated install, said out loud.
//
// BuildEx only gates what it has an overlay for. Installing anything else is a
// deliberate product decision — the same one the agents' own plugin browsers
// make — and a decision the operator is entitled to make knowingly, which means
// naming who wrote it and where it comes from at the moment of the click.

export default function UngatedInstallDialog({
  entry,
  onCancel,
  onConfirm
}: {
  entry: StoreEntry | null
  onCancel: () => void
  onConfirm: (entry: StoreEntry) => void
}): React.JSX.Element | null {
  if (!entry) {
    return null
  }

  const name = storeEntryDisplayName(entry)
  const provenance = describePluginSource(entry.plugin.source)
  const webUrl = pluginSourceWebUrl(entry.plugin.source)

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-muted-foreground" />
            {translate('buildex.store.ungated.title', 'Install {{value0}} ungated?', {
              value0: name
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'buildex.store.ungated.body',
              'BuildEx has not reviewed this plugin, so none of its actions wait for you. It runs with whatever your agent already allows.'
            )}
          </DialogDescription>
        </DialogHeader>

        <dl className="flex flex-col gap-2 rounded-md border border-border p-3 text-[12px]">
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-muted-foreground">
              {translate('buildex.store.ungated.from', 'From')}
            </dt>
            <dd className="min-w-0 flex-1">{entry.marketplaceLabel}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-muted-foreground">
              {translate('buildex.store.ungated.author', 'Author')}
            </dt>
            <dd className="min-w-0 flex-1">
              {entry.plugin.author ??
                translate('buildex.store.ungated.authorUnknown', 'Not stated')}
            </dd>
          </div>
          {provenance ? (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">
                {translate('buildex.store.ungated.source', 'Source')}
              </dt>
              <dd className="min-w-0 flex-1 font-mono text-[11px] break-all">{provenance}</dd>
            </div>
          ) : null}
        </dl>

        <DialogFooter className="sm:items-center">
          {webUrl ? (
            <Button
              variant="link"
              size="sm"
              className="mr-auto px-0"
              onClick={() => void window.api.shell.openUrl(webUrl)}
            >
              {translate('buildex.store.ungated.review', 'Read the source first')}
              <ExternalLink />
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {translate('buildex.store.ungated.cancel', 'Cancel')}
          </Button>
          <Button size="sm" onClick={() => onConfirm(entry)}>
            {translate('buildex.store.ungated.confirm', 'Install ungated')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
