import React from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, Paperclip, Plus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  BrainAttachment,
  BrainDocument,
  BrainNode
} from '../../../../shared/buildex-brain-types'

// One section, and — through itself — every subsection under it.
//
// Recursive because the brain is: `clients/enterprise/acme` is a section holding
// a subsection holding a client, and each level draws the same three things (its
// documents, its attachments, its children) at a smaller weight.
//
// A folder with a main file — what the context render counts as an entity — is
// drawn as a folder whose title opens that file. One taxonomy on screen: the
// operator learns folders and documents, and the main-file convention shows up
// as a folder that opens, not as a second kind of thing with its own page.

/** What Add makes. `folder` writes the folder plus the main file that opens it. */
export type BrainAddKind = 'document' | 'folder'

export default function BrainSectionBlock({
  node,
  depth = 0,
  purpose,
  collapsed,
  onToggleCollapsed,
  onOpenDocument,
  onOpenAttachment,
  onAdd,
  renderAdding
}: {
  node: BrainNode
  depth?: number
  purpose?: string
  collapsed?: boolean
  onToggleCollapsed?: (folder: string) => void
  onOpenDocument: (documentId: string) => void
  onOpenAttachment: (attachmentId: string) => void
  onAdd: (folder: string, kind: BrainAddKind) => void
  /** The name-it field, drawn by the owner of the state, beside the folder it will write into. */
  renderAdding?: (folder: string) => React.ReactNode
}): React.JSX.Element {
  const isTop = depth === 0
  const Chevron = collapsed ? ChevronRight : ChevronDown

  // Why: a brain with ten declared sections and three filled ones was mostly
  // empty blocks — purpose, placeholder, Add, times seven. An empty section is
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
        {renderAdding?.(node.path)}
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
        ) : node.main ? (
          <MainFileLabel node={node} main={node.main} onOpenDocument={onOpenDocument} />
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

          {renderAdding?.(node.path)}

          <BrainDocumentRow documents={node.documents} onOpen={onOpenDocument} />

          <BrainAttachmentRow attachments={node.attachments} onOpen={onOpenAttachment} />

          {node.children.map((child) => (
            <BrainSectionBlock
              key={child.path}
              node={child}
              depth={depth + 1}
              onOpenDocument={onOpenDocument}
              onOpenAttachment={onOpenAttachment}
              onAdd={onAdd}
              renderAdding={renderAdding}
            />
          ))}
        </>
      )}
    </section>
  )
}

/**
 * A folder whose main file is what clicking it opens.
 *
 * The summary rides the same line rather than taking one of its own — the same
 * bound the agent-facing render is held to, for the same reason: twenty clients
 * must read as twenty lines.
 */
function MainFileLabel({
  node,
  main,
  onOpenDocument
}: {
  node: BrainNode
  main: NonNullable<BrainNode['main']>
  onOpenDocument: (documentId: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpenDocument(main.documentId)}
      className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-accent"
    >
      <Folder size={11} className="shrink-0 text-muted-foreground/50" />
      <SectionLabel node={node} isTop={false} />
      {main.summary ? (
        <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
          {main.summary}
        </span>
      ) : null}
      {node.changed ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-amber-500"
          aria-label={translate('buildex.brain.entity.unsaved', 'Unsaved')}
        />
      ) : null}
    </button>
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

/**
 * A row of documents, each as a chip.
 *
 * The description is the reason to click one, so it travels with the title at
 * every depth: a document that reads differently depending on where it is listed
 * is a document nobody trusts.
 */
export function BrainDocumentRow({
  documents,
  onOpen
}: {
  documents: BrainDocument[]
  onOpen: (documentId: string) => void
}): React.JSX.Element | null {
  if (documents.length === 0) {
    return null
  }
  return (
    <ul className="flex flex-wrap gap-x-1 gap-y-0.5">
      {documents.map((document) => (
        <li key={document.id}>
          <button
            type="button"
            onClick={() => onOpen(document.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[12px] hover:bg-accent',
              // Why: a described document earns the extra width, so the title it
              // shares the chip with is not truncated to make room.
              document.description ? 'max-w-[26rem]' : 'max-w-[18rem]'
            )}
          >
            <FileText size={11} className="shrink-0 text-muted-foreground/50" />
            <span className="min-w-0 flex-1 truncate">{document.title}</span>
            {document.description ? (
              <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
                {document.description}
              </span>
            ) : null}
            {document.changed ? (
              <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
            ) : null}
          </button>
        </li>
      ))}
    </ul>
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

// Two things the brain is made of, named as themselves. A folder is a folder
// here and everywhere else in the app — the taxonomy this retired was the
// *entity*: its own page, its own card, its own word. Making a client is still
// making a folder, and no other affordance in BuildEx can make one.
function AddControl({
  node,
  onAdd
}: {
  node: BrainNode
  onAdd: (folder: string, kind: BrainAddKind) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent">
        <Plus size={11} />
        {translate('buildex.brain.sections.add', 'Add')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onAdd(node.path, 'document')}>
          {translate('buildex.brain.sections.newDocument', 'New document')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAdd(node.path, 'folder')}>
          {translate('buildex.brain.sections.newFolder', 'New folder')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function countLabel(node: BrainNode): string {
  // One unit everywhere, so the rail and this header never disagree — and one
  // word. A section that counted itself in "entities" was the last place the
  // retired taxonomy still spoke to the operator: twenty client folders read as
  // "20 entities" while every other count in the app was documents.
  return node.documentCount === 1
    ? translate('buildex.brain.sections.documentCountOne', '1 document')
    : translate('buildex.brain.sections.documentCount', '{{value0}} documents', {
        value0: node.documentCount
      })
}

function isEmpty(node: BrainNode): boolean {
  return node.documents.length === 0 && node.attachments.length === 0 && node.children.length === 0
}
