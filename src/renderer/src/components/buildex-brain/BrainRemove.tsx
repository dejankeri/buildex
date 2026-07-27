import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { BrainRemovalPlan } from '../../../../shared/buildex-brain-types'

// Confirming the removal of the company brain.
//
// Deliberately not a "this cannot be undone" warning, because it can: the
// removal is committed when git holds the brain, and a copy is taken when git
// does not. So this dialog's job is to say which of those is about to happen,
// in the operator's own terms. A confirmation that describes the outcome is
// worth more than one that asks somebody to accept a risk they cannot see.

const EMPTY_PLAN: BrainRemovalPlan = {
  documentCount: 0,
  unsavedPaths: [],
  canCommit: false,
  willBackUp: false
}

export default function BrainRemove({
  repoPath,
  open,
  onOpenChange,
  onRemoved
}: {
  repoPath: string
  open: boolean
  onOpenChange: (next: boolean) => void
  onRemoved: (backupPath?: string) => void
}): React.JSX.Element {
  const [plan, setPlan] = useState<BrainRemovalPlan>(EMPTY_PLAN)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setError(null)
    let cancelled = false
    void window.api.buildexBrain.removalPlan({ repoPath }).then((next) => {
      if (!cancelled) {
        setPlan(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, repoPath])

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.buildexBrain.remove({ repoPath })
      if (!result.ok) {
        setError(result.error ?? translate('buildex.brain.remove.failed', 'Could not remove it.'))
        return
      }
      onOpenChange(false)
      onRemoved(result.backupPath)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[30rem] max-w-[92vw]">
        <DialogHeader>
          <DialogTitle>
            {translate('buildex.brain.remove.title', 'Remove the company brain?')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'buildex.brain.remove.body',
              'This takes {{value0}} documents out of the repo. You can set a new brain up here afterwards.',
              { value0: plan.documentCount }
            )}
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1.5 text-[12px] text-muted-foreground">
          {plan.canCommit ? (
            <li>
              {translate(
                'buildex.brain.remove.committed',
                'The removal is saved to history, so it can be undone from the repo.'
              )}
            </li>
          ) : null}
          {plan.willBackUp ? (
            <li>
              {translate(
                'buildex.brain.remove.backedUp',
                '{{value0}} files are not in history yet, so a copy goes to ~/.buildex-backups first.',
                { value0: plan.unsavedPaths.length || plan.documentCount }
              )}
            </li>
          ) : null}
          <li>
            {translate(
              'buildex.brain.remove.keeps',
              'Nothing outside .buildex is touched — your code and its history stay exactly as they are.'
            )}
          </li>
        </ul>

        {error ? <p className="text-[12px] text-destructive">{error}</p> : null}

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-8 items-center rounded-md px-3 text-[12px] text-muted-foreground hover:bg-accent"
          >
            {translate('buildex.brain.remove.cancel', 'Keep it')}
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="inline-flex h-8 items-center gap-2 rounded-md bg-destructive px-3 text-[12px] font-medium text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            {translate('buildex.brain.remove.confirm', 'Remove the brain')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
