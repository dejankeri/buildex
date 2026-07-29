import React from 'react'
import { ChevronLeft, FileText, PenLine } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { BrainNode } from '../../../../shared/buildex-brain-types'
import { BrainAttachmentRow } from './BrainSectionBlock'

// One entity as a place of its own.
//
// The main file is opened in the existing document editor rather than edited
// here — one editor in the app, not two that drift. What this page adds is
// everything the editor cannot show: the rest of the folder.

export default function BrainEntityPage({
  node,
  breadcrumb,
  onBack,
  onOpenDocument,
  onOpenAttachment
}: {
  node: BrainNode
  /** Section titles above this entity, outermost first. */
  breadcrumb: string[]
  onBack: () => void
  onOpenDocument: (documentId: string) => void
  onOpenAttachment: (attachmentId: string) => void
}): React.JSX.Element {
  const groups = documentGroups(node)
  const attachments = allAttachments(node)

  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex items-center gap-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft size={12} />
        {breadcrumb.join(' / ')}
      </button>

      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[18px] font-semibold tracking-tight">{node.title}</h1>
          <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
            {node.main?.summary || translate('buildex.brain.entity.noSummary', 'No summary yet')}
          </p>
        </div>
        {node.main ? (
          <button
            type="button"
            onClick={() => onOpenDocument(node.main?.documentId ?? '')}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] shadow-xs hover:bg-accent"
          >
            <PenLine size={12} />
            {translate('buildex.brain.entity.edit', 'Edit')}
          </button>
        ) : null}
      </header>

      {groups.length > 0 ? (
        <section className="mt-5 flex flex-col gap-2">
          <h2 className="text-[11px] font-semibold tracking-[0.05em] uppercase text-muted-foreground">
            {translate('buildex.brain.entity.documents', 'Documents')}
          </h2>
          {groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              {group.label ? (
                <p className="text-[11px] text-muted-foreground/70">{group.label}</p>
              ) : null}
              <ul className="flex flex-wrap gap-x-1 gap-y-0.5">
                {group.documents.map((document) => (
                  <li key={document.id}>
                    <button
                      type="button"
                      onClick={() => onOpenDocument(document.id)}
                      className="flex max-w-[18rem] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] hover:bg-accent"
                    >
                      <FileText size={11} className="shrink-0 text-muted-foreground/50" />
                      <span className="min-w-0 flex-1 truncate">{document.title}</span>
                      {document.changed ? (
                        <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      {attachments.length > 0 ? (
        <section className="mt-5 flex flex-col gap-2">
          <h2 className="text-[11px] font-semibold tracking-[0.05em] uppercase text-muted-foreground">
            {translate('buildex.brain.entity.attachments', 'Attachments')}
          </h2>
          <BrainAttachmentRow attachments={attachments} onOpen={onOpenAttachment} />
          <p className="text-[11px] text-muted-foreground/60">
            {translate(
              'buildex.brain.entity.attachmentsHint',
              'Opened outside BuildEx. Their contents are never read, and never reach the agent.'
            )}
          </p>
        </section>
      ) : null}
    </div>
  )
}

type DocumentGroup = { label: string; documents: BrainNode['documents'] }

/** The entity's own documents first, then each subfolder under its own name. */
function documentGroups(node: BrainNode): DocumentGroup[] {
  const groups: DocumentGroup[] = []
  if (node.documents.length > 0) {
    groups.push({ label: '', documents: node.documents })
  }
  const walk = (child: BrainNode, prefix: string): void => {
    const label = prefix ? `${prefix} / ${child.title}` : child.title
    if (child.documents.length > 0) {
      groups.push({ label, documents: child.documents })
    }
    for (const nested of child.children) {
      walk(nested, label)
    }
  }
  for (const child of node.children) {
    walk(child, '')
  }
  return groups
}

function allAttachments(node: BrainNode): BrainNode['attachments'] {
  return [...node.attachments, ...node.children.flatMap((child) => allAttachments(child))].sort(
    (a, b) => a.id.localeCompare(b.id)
  )
}
