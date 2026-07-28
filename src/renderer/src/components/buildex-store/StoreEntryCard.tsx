import React from 'react'
import { Check, Loader2, Package, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { StoreEntry, StoreRequirement } from '../../../../shared/buildex-store-types'
import StoreConnectRow from './StoreConnectRow'
import StoreRequirementMenu from './StoreRequirementMenu'
import { storeEntryDescription, storeEntryDisplayName } from './store-entry-search'

// One plugin on a shelf.
//
// The card carries the facts a person needs before installing something that
// will act on their behalf: who published it, whether their company expects it,
// and whether BuildEx gates it. An uncurated plugin says so on its face and
// again in the dialog — burying it in a tooltip would make the quiet default the
// uninformed one.
//
// Two chip families, at most one from each, in a fixed order. The company's
// expectation is a word chip and comes first because it is the reason the card
// is where it is; trust is a shield chip and comes second because it qualifies
// the install rather than motivating it. Three equal chips would rank nothing.

function RequirementBadge({ requirement }: { requirement: StoreRequirement }): React.JSX.Element {
  return requirement === 'required' ? (
    <Badge variant="secondary" className="px-1.5 text-[10px]">
      {translate('buildex.store.card.required', 'Required')}
    </Badge>
  ) : (
    <Badge variant="outline" className="px-1.5 text-[10px] text-muted-foreground">
      {translate('buildex.store.card.suggested', 'Suggested')}
    </Badge>
  )
}

function TrustBadge({ entry }: { entry: StoreEntry }): React.JSX.Element | null {
  if (!entry.curated) {
    return (
      <Badge variant="outline" className="px-1.5 text-[10px] text-muted-foreground">
        <ShieldAlert />
        {translate('buildex.store.card.unverified', 'Unverified')}
      </Badge>
    )
  }
  return entry.overlay?.gate ? (
    <Badge variant="secondary" className="px-1.5 text-[10px]">
      <ShieldCheck />
      {translate('buildex.store.card.gated', 'Ask-first')}
    </Badge>
  ) : null
}

export default function StoreEntryCard({
  entry,
  worktreeId,
  busy,
  installDisabled,
  rosterDisabled,
  onInstall,
  onUninstall,
  onSetRequirement,
  onChanged
}: {
  entry: StoreEntry
  worktreeId: string | null
  busy: boolean
  installDisabled: boolean
  rosterDisabled: boolean
  onInstall: (entry: StoreEntry) => void
  onUninstall: (entry: StoreEntry) => void
  onSetRequirement: (entry: StoreEntry, requirement: StoreRequirement | null) => void
  onChanged: () => void | Promise<void>
}): React.JSX.Element {
  const name = storeEntryDisplayName(entry)
  const author = entry.plugin.author
  const hasTrustBadge = !entry.curated || Boolean(entry.overlay?.gate)

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-xs">
      <div className="flex items-start gap-2">
        {entry.overlay?.icon ? (
          <span className="text-[18px] leading-none">{entry.overlay.icon}</span>
        ) : (
          <Package className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{name}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {author
              ? translate('buildex.store.card.byline', '{{value0}} · by {{value1}}', {
                  value0: entry.marketplaceLabel,
                  value1: author
                })
              : entry.marketplaceLabel}
          </div>
        </div>
        <StoreRequirementMenu entry={entry} disabled={rosterDisabled} onSet={onSetRequirement} />
      </div>

      {entry.requirement || hasTrustBadge ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {entry.requirement ? <RequirementBadge requirement={entry.requirement} /> : null}
          <TrustBadge entry={entry} />
        </div>
      ) : null}

      {/* Why: the reason is the operator's own sentence, so it reads as prose
          under the chip that frames it rather than as another chip. */}
      {entry.requirementReason ? (
        <p className="text-[11px] text-muted-foreground">{entry.requirementReason}</p>
      ) : null}

      <p className="line-clamp-3 min-h-[2.5rem] text-[12px] text-muted-foreground">
        {storeEntryDescription(entry)}
      </p>

      {entry.installed ? (
        <div className="flex items-center gap-1">
          <span className="inline-flex h-7 flex-1 items-center justify-center gap-1 text-[12px] font-medium text-muted-foreground">
            <Check size={12} />
            {translate('buildex.store.page.installed', 'Installed')}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${translate('buildex.store.page.uninstall', 'Uninstall')} ${name}`}
            disabled={busy || installDisabled}
            onClick={() => onUninstall(entry)}
            title={translate(
              'buildex.store.card.uninstallHint',
              'Removes the plugin through the agent that installed it.'
            )}
            className="text-muted-foreground hover:text-destructive"
          >
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
          </Button>
        </div>
      ) : (
        <Button
          size="xs"
          className="w-full"
          aria-label={`${translate('buildex.store.page.install', 'Install')} ${name}`}
          disabled={busy || installDisabled}
          onClick={() => onInstall(entry)}
        >
          {busy ? (
            <Loader2 className="animate-spin" />
          ) : (
            translate('buildex.store.page.install', 'Install')
          )}
        </Button>
      )}

      {/* Why: the warning belongs where the decision is made, not only behind the
          dialog the operator is about to confirm out of habit. */}
      {!entry.curated && !entry.installed ? (
        <p className="text-[11px] text-muted-foreground/70">
          {translate('buildex.store.card.ungatedHint', 'Installs ungated — nothing waits for you.')}
        </p>
      ) : null}

      {/* Why: connecting only matters once the plugin is there, so it appears
          after install rather than competing with it. */}
      {entry.installed ? (
        <StoreConnectRow entry={entry} worktreeId={worktreeId} onChanged={onChanged} />
      ) : null}
    </div>
  )
}
