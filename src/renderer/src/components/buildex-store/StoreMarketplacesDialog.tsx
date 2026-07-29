import React, { useState } from 'react'
import { Loader2, Lock, Plus, Trash2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { StoreMarketplace, StoreSegment } from '../../../../shared/buildex-store-types'

// Where this company's apps come from.
//
// The three bundled marketplaces are shown but not removable — they are what
// BuildEx ships and stands behind. Everything below them is the company's own,
// and lives in the brain rather than on this machine, because a marketplace only
// one person can see makes the shelf different for every teammate.
//
// The id is deliberately not a field. It has to be the name the marketplace
// declares about itself, so it is read from the manifest when the marketplace is
// added — an id typed by hand would install fine and then report every plugin as
// not-installed, forever and quietly.

export type StoreMarketplacesDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  marketplaces: readonly StoreMarketplace[]
  /** Where company marketplaces are written, or null when there is no brain. */
  marketplacesPath: string | null
  repoPath: string | null
  /** Resolves true when the marketplace landed; false leaves the form as typed. */
  onAdd: (input: { label: string; repo: string; defaultSegment: StoreSegment }) => Promise<boolean>
  onRemove: (id: string) => Promise<void>
  busy: boolean
  error: string | null
}

export default function StoreMarketplacesDialog({
  open,
  onOpenChange,
  marketplaces,
  marketplacesPath,
  repoPath,
  onAdd,
  onRemove,
  busy,
  error
}: StoreMarketplacesDialogProps): React.JSX.Element {
  const [label, setLabel] = useState('')
  const [repo, setRepo] = useState('')
  const [segment, setSegment] = useState<StoreSegment>('business')

  const bundled = marketplaces.filter((entry) => entry.origin === 'bundled')
  const company = marketplaces.filter((entry) => entry.origin === 'company')
  // No brain is no place to put one: the list is a company document, not a
  // machine setting, so there is nowhere for an add to land.
  const canAdd = Boolean(repoPath) && marketplacesPath !== null
  const submittable = canAdd && !busy && label.trim().length > 0 && repo.trim().length > 0

  const submit = async (): Promise<void> => {
    if (!submittable) {
      return
    }
    // Why only on success: a rejected add is usually a typo in the repo, and
    // clearing the form would make the operator retype the whole thing to fix
    // one character.
    if (await onAdd({ label: label.trim(), repo: repo.trim(), defaultSegment: segment })) {
      setLabel('')
      setRepo('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{translate('buildex.store.marketplaces.title', 'Marketplaces')}</DialogTitle>
          <DialogDescription>
            {translate(
              'buildex.store.marketplaces.body',
              'Where this company’s apps come from. Ones you add live in the brain, so a teammate gets them by cloning.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto scrollbar-sleek">
          {bundled.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{entry.label}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {entry.repo}
                </div>
              </div>
              <span
                className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                title={translate(
                  'buildex.store.marketplaces.bundledHint',
                  'Ships with BuildEx and cannot be removed.'
                )}
              >
                <Lock size={11} />
                {translate('buildex.store.marketplaces.bundled', 'Built in')}
              </span>
            </div>
          ))}

          {company.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{entry.label}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {entry.repo}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={translate('buildex.store.marketplaces.remove', 'Remove {{value0}}', {
                  value0: entry.label
                })}
                title={translate(
                  'buildex.store.marketplaces.removeHint',
                  'Takes it off the shelf. Apps you already installed from it stay installed.'
                )}
                onClick={() => void onRemove(entry.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>

        <div className="space-y-3 border-t border-border pt-3">
          <div className="space-y-1">
            <Label htmlFor="store-marketplace-repo">
              {translate('buildex.store.marketplaces.repoLabel', 'Marketplace')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'buildex.store.marketplaces.repoHint',
                'owner/repo, or an https URL to a marketplace.json your company hosts.'
              )}
            </p>
            <Input
              id="store-marketplace-repo"
              value={repo}
              disabled={!canAdd || busy}
              onChange={(event) => setRepo(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void submit()
                }
              }}
              placeholder={translate(
                'buildex.store.marketplaces.repoPlaceholder',
                'acme/claude-plugins'
              )}
              className="h-8 font-mono text-[12px]"
            />
          </div>

          <div className="flex gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor="store-marketplace-label">
                {translate('buildex.store.marketplaces.nameLabel', 'Name')}
              </Label>
              <Input
                id="store-marketplace-label"
                value={label}
                disabled={!canAdd || busy}
                onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void submit()
                  }
                }}
                placeholder={translate('buildex.store.marketplaces.namePlaceholder', 'Acme apps')}
                className="h-8 text-[13px]"
              />
            </div>
            <div className="w-40 shrink-0 space-y-1">
              <Label htmlFor="store-marketplace-segment">
                {translate('buildex.store.marketplaces.shelfLabel', 'Shelf')}
              </Label>
              <Select
                value={segment}
                disabled={!canAdd || busy}
                onValueChange={(next) => setSegment(next as StoreSegment)}
              >
                <SelectTrigger id="store-marketplace-segment" className="h-8 w-full text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="business">
                    {translate('buildex.store.segment.business', 'Run your business')}
                  </SelectItem>
                  <SelectItem value="software">
                    {translate('buildex.store.segment.software', 'Build software')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {error ? <p className="text-[12px] text-destructive">{error}</p> : null}

          {!canAdd ? (
            <p className="text-[11px] text-muted-foreground">
              {repoPath
                ? translate(
                    'buildex.store.marketplaces.noBrain',
                    'Set up a company brain first — marketplaces live in it.'
                  )
                : translate(
                    'buildex.store.marketplaces.noRepo',
                    'Open a project to add a marketplace.'
                  )}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'buildex.store.marketplaces.committed',
                'Written to {{value0}} — commit it to share these with your team.',
                { value0: marketplacesPath ?? '' }
              )}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {translate('buildex.store.marketplaces.close', 'Done')}
          </Button>
          <Button size="sm" disabled={!submittable} onClick={() => void submit()}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            {translate('buildex.store.marketplaces.add', 'Add marketplace')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
