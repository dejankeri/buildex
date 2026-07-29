import React from 'react'
import { FileText, Paperclip } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { BrainNode } from '../../../../shared/buildex-brain-types'

// One entity — a client, a person — as a card.
//
// Cards are the only thing on this page at the subtle-lift tier, which is what
// makes a section of entities read differently at a glance from a section of
// documents without either of them being labelled.

export default function BrainEntityCard({
  node,
  onOpen
}: {
  node: BrainNode
  onOpen: (entityPath: string) => void
}): React.JSX.Element {
  const attachments = countAttachments(node)
  return (
    <button
      type="button"
      onClick={() => onOpen(node.path)}
      className="flex min-w-0 flex-col items-start gap-1 rounded-xl border border-border bg-card p-3 text-left shadow-xs transition-colors hover:border-ring/40 hover:bg-accent/40"
    >
      <span className="flex w-full items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{node.title}</span>
        {node.changed ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-amber-500"
            aria-label={translate('buildex.brain.entity.unsaved', 'Unsaved')}
          />
        ) : null}
      </span>

      {node.main?.summary ? (
        <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground/80">
          {node.main.summary}
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground/50">
          {translate('buildex.brain.entity.noSummary', 'No summary yet')}
        </span>
      )}

      <span className="mt-auto flex items-center gap-2.5 pt-1 text-[11px] tabular-nums text-muted-foreground/70">
        <span className="flex items-center gap-1">
          <FileText size={10} />
          {node.documentCount}
        </span>
        {attachments > 0 ? (
          <span className="flex items-center gap-1">
            <Paperclip size={10} />
            {attachments}
          </span>
        ) : null}
      </span>
    </button>
  )
}

/** Attachments anywhere under the entity — the card speaks for the whole folder. */
export function countAttachments(node: BrainNode): number {
  return (
    node.attachments.length + node.children.reduce((sum, child) => sum + countAttachments(child), 0)
  )
}
