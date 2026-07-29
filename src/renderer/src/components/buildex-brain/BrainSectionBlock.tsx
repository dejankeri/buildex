import React from 'react'
import { ChevronDown, ChevronRight, FileText, Paperclip, Plus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { BrainAttachment, BrainNode } from '../../../../shared/buildex-brain-types'
import BrainEntityCard from './BrainEntityCard'

// One section, and — through itself — every subsection under it.
//
// Recursive because the brain is: `clients/enterprise/acme` is a section holding
// a subsection holding an entity, and each level draws the same three things
// (its documents, its attachments, its children) at a smaller weight.

export type BrainAddKind = 'document' | 'entity'

export default function BrainSectionBlock({
  node,
  depth = 0,
  purpose,
  collapsed,
  onToggleCollapsed,
  onOpenDocument,
  onOpenEntity,
  onOpenAttachment,
  onAdd
}: {
  node: BrainNode
  depth?: number
  purpose?: string
  collapsed?: boolean
  onToggleCollapsed?: (folder: string) => void
  onOpenDocument: (documentId: string) => void
  onOpenEntity: (entityPath: string) => void
  onOpenAttachment: (attachmentId: string) => void
  onAdd: (folder: string, kind: BrainAddKind) => void
}): React.JSX.Element {
  const entities = node.children.filter((child) => child.kind === 'entity')
  const subsections = node.children.filter((child) => child.kind !== 'entity')
  const isTop = depth === 0
  const Chevron = collapsed ? ChevronRight : ChevronDown

  // Why: a brain with nine declared sections and three filled ones was mostly
  // empty blocks — purpose, placeholder, Add, times six. An empty section is
  // worth one line: enough to know it exists and to start filling it.
  if (isTop && isEmpty(node)) {
    return (
      <section className="flex items-center gap-2 py-2">
        <SectionLabel node={node} isTop />
        {purpose ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/60">
            {purpose}
          </span>
        ) : null}
        <AddControl node={node} onAdd={onAdd} />
      </section>
    )
  }

  return (
    <section className={cn('flex flex-col', isTop ? 'gap-2 py-4' : 'gap-1.5 pt-3 pl-3')}>
      <header className="flex items-center gap-2">
        {isTop && onToggleCollapsed ? (
          <button
            type="button"
            onClick={() => onToggleCollapsed(node.path)}
            aria-expanded={!collapsed}
            className="flex min-w-0 items-center gap-1.5 rounded-md text-muted-foreground hover:text-foreground"
          >
            <Chevron size={13} className="shrink-0" />
            <SectionLabel node={node} isTop={isTop} />
          </button>
        ) : (
          <SectionLabel node={node} isTop={isTop} />
        )}

        <span className="text-[11px] tabular-nums text-muted-foreground/70">
          {countLabel(node)}
        </span>

        {collapsed ? null : <AddControl node={node} onAdd={onAdd} />}
      </header>

      {collapsed ? null : (
        <>
          {isTop && purpose ? (
            <p className="text-[11px] leading-snug text-muted-foreground/80">{purpose}</p>
          ) : null}

          {node.documents.length > 0 ? (
            <ul className="flex flex-wrap gap-x-1 gap-y-0.5">
              {node.documents.map((document) => (
                <li key={document.id}>
                  <button
                    type="button"
                    onClick={() => onOpenDocument(document.id)}
                    className="flex max-w-[18rem] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[12px] hover:bg-accent"
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
          ) : null}

          <BrainAttachmentRow attachments={node.attachments} onOpen={onOpenAttachment} />

          {entities.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2 pt-0.5">
              {entities.map((entity) => (
                <BrainEntityCard key={entity.path} node={entity} onOpen={onOpenEntity} />
              ))}
            </div>
          ) : null}

          {subsections.map((child) => (
            <BrainSectionBlock
              key={child.path}
              node={child}
              depth={depth + 1}
              onOpenDocument={onOpenDocument}
              onOpenEntity={onOpenEntity}
              onOpenAttachment={onOpenAttachment}
              onAdd={onAdd}
            />
          ))}
        </>
      )}
    </section>
  )
}

function SectionLabel({ node, isTop }: { node: BrainNode; isTop: boolean }): React.JSX.Element {
  return (
    <h2
      className={cn(
        'min-w-0 truncate',
        isTop
          ? 'text-[11px] font-semibold tracking-[0.05em] uppercase'
          : 'text-[12px] font-medium text-muted-foreground'
      )}
    >
      {node.title}
    </h2>
  )
}

export function BrainAttachmentRow({
  attachments,
  onOpen
}: {
  attachments: BrainAttachment[]
  onOpen: (attachmentId: string) => void
}): React.JSX.Element | null {
  if (attachments.length === 0) {
    return null
  }
  return (
    <ul className="flex flex-wrap gap-1">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          <button
            type="button"
            onClick={() => onOpen(attachment.id)}
            title={translate('buildex.brain.attachment.open', 'Open outside BuildEx')}
            className="flex max-w-[16rem] items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
          >
            <Paperclip size={10} className="shrink-0 text-muted-foreground/50" />
            <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function AddControl({
  node,
  onAdd
}: {
  node: BrainNode
  onAdd: (folder: string, kind: BrainAddKind) => void
}): React.JSX.Element {
  const className =
    'ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent'

  // Why: both choices everywhere, including a section that holds no entity yet.
  // Offering "New entity" only where one already exists made the first one
  // uncreatable — an empty Clients could never become a Clients with a client
  // in it. No folder is barred from holding an entity, so none hides the option.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={className}>
        <Plus size={11} />
        {translate('buildex.brain.sections.add', 'Add')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onAdd(node.path, 'entity')}>
          {translate('buildex.brain.sections.newEntity', 'New entity')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd(node.path, 'document')}>
          {translate('buildex.brain.sections.newDocument', 'New document')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function countLabel(node: BrainNode): string {
  // One unit per section, so the rail and this header never disagree: a section
  // of entities is counted in entities, everything else in documents.
  if (node.entityCount > 0) {
    return node.entityCount === 1
      ? translate('buildex.brain.sections.entityCountOne', '1 entity')
      : translate('buildex.brain.sections.entityCount', '{{value0}} entities', {
          value0: node.entityCount
        })
  }
  return node.documentCount === 1
    ? translate('buildex.brain.sections.documentCountOne', '1 document')
    : translate('buildex.brain.sections.documentCount', '{{value0}} documents', {
        value0: node.documentCount
      })
}

function isEmpty(node: BrainNode): boolean {
  return node.documents.length === 0 && node.attachments.length === 0 && node.children.length === 0
}
