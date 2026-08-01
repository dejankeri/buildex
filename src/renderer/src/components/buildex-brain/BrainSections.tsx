import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { BrainScan, BrainSectionInfo } from '../../../../shared/buildex-brain-types'
import BrainSectionBlock, { type BrainAddKind } from './BrainSectionBlock'
import BrainWantedPages from './BrainWantedPages'
import { filterBrainTree } from './brain-tree-filter'

// Browsing the brain, and adding to it.
//
// Sections stack full width rather than sitting in a card grid, because a grid
// gave a company's nine areas and its twenty clients the same weight and the
// same size. The rail is how a long page stays navigable; collapse is how it
// stays short.

const CREATE_FAILED = (): string =>
  translate('buildex.brain.sections.createFailed', 'Could not create it')

export default function BrainSections({
  scan,
  sections,
  repoPath,
  brainRoot,
  onOpenDocument,
  onCreated
}: {
  scan: BrainScan
  sections: BrainSectionInfo[]
  repoPath: string | null
  brainRoot: string | null
  onOpenDocument: (documentId: string) => void
  onCreated: () => void | Promise<void>
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [creatingIn, setCreatingIn] = useState<{ folder: string; kind: BrainAddKind } | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState<string | null>(null)

  const collapsed = useAppStore((state) => state.collapsedBrainSections)
  const toggleCollapsed = useAppStore((state) => state.toggleCollapsedBrainSection)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef(new Map<string, HTMLDivElement>())

  const purposes = useMemo(
    () => new Map(sections.map((section) => [section.folder, section.purpose])),
    [sections]
  )
  const tree = useMemo(() => filterBrainTree(scan.tree, query), [scan.tree, query])

  const isCollapsed = useCallback(
    (folder: string): boolean =>
      // Filtering is a search: honouring collapse would hide the very thing
      // somebody just typed the name of.
      query.trim() === '' && collapsed.has(`${repoPath ?? ''}::${folder}`),
    [collapsed, query, repoPath]
  )

  const openAttachment = useCallback(
    (attachmentId: string): void => {
      if (!brainRoot) {
        return
      }
      void window.api.shell.openPath(`${brainRoot.replace(/[/\\]$/, '')}/${attachmentId}`)
    },
    [brainRoot]
  )

  const create = async (): Promise<void> => {
    const name = title.trim()
    if (!repoPath || !creatingIn || !name) {
      setCreatingIn(null)
      return
    }
    const { folder, kind } = creatingIn
    setCreatingIn(null)
    setTitle('')

    // A folder is the folder plus the main file that stands for it — the one
    // convention the Brain reads, and nothing else in BuildEx writes it.
    const result =
      kind === 'folder'
        ? await window.api.buildexBrainSections.createEntity({
            repoPath,
            parentFolder: folder,
            title: name
          })
        : await window.api.buildexBrainSections.createDocument({ repoPath, folder, title: name })
    if (!result.ok) {
      setError(result.error ?? CREATE_FAILED())
      return
    }
    setError(null)
    await onCreated()
    // Both land in the same place: the file the operator is about to write in.
    // For a folder that is its main file, which is what clicking the folder
    // opens from now on — so creating one and clicking one agree.
    if (result.documentId) {
      onOpenDocument(result.documentId)
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="scrollbar-sleek flex w-44 shrink-0 flex-col gap-2 overflow-y-auto border-r border-border p-3">
        <label className="relative flex items-center">
          <Search size={12} className="absolute left-2 text-muted-foreground/50" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate('buildex.brain.sections.filter', 'Filter')}
            className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-2 text-[12px] outline-none focus:ring-[3px] focus:ring-ring/50"
          />
        </label>

        <ul className="flex flex-col">
          {tree.map((node) => (
            <li key={node.path || 'root'}>
              <button
                type="button"
                onClick={() => {
                  sectionRefs.current.get(node.path)?.scrollIntoView({ block: 'start' })
                }}
                aria-current={current === node.path ? 'true' : undefined}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-accent',
                  current === node.path
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{node.title}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                  {node.entityCount > 0 ? node.entityCount : node.documentCount}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div
        ref={scrollRef}
        onScroll={() => setCurrent(topmostSection(scrollRef.current, sectionRefs.current))}
        className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-5"
      >
        {error ? <p className="pt-3 text-[12px] text-destructive">{error}</p> : null}

        {tree.length === 0 ? (
          <p className="pt-6 text-[12px] text-muted-foreground/60">
            {translate('buildex.brain.sections.noMatches', 'Nothing matches that')}
          </p>
        ) : null}

        {tree.map((node) => (
          <div
            key={node.path || 'root'}
            ref={(element) => {
              if (element) {
                sectionRefs.current.set(node.path, element)
              } else {
                sectionRefs.current.delete(node.path)
              }
            }}
            className="border-b border-border last:border-b-0"
          >
            <BrainSectionBlock
              node={node}
              purpose={purposes.get(node.path)}
              collapsed={isCollapsed(node.path)}
              onToggleCollapsed={(folder) => toggleCollapsed(`${repoPath ?? ''}::${folder}`)}
              onOpenDocument={onOpenDocument}
              onOpenAttachment={openAttachment}
              onAdd={(folder, kind) => {
                setTitle('')
                setCreatingIn({ folder, kind })
              }}
              // Why a render prop: Add sits on every folder, so the field has to
              // appear beside the one that was clicked. Held here because the
              // draft title belongs to the page, not to whichever block drew it.
              renderAdding={(folder) =>
                creatingIn?.folder === folder ? (
                  <input
                    autoFocus
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    onBlur={() => setCreatingIn(null)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void create()
                      }
                      if (event.key === 'Escape') {
                        setCreatingIn(null)
                      }
                    }}
                    placeholder={translate('buildex.brain.sections.nameIt', 'Name it, then Enter')}
                    className="h-7 w-full max-w-sm rounded-md border border-input bg-background px-2 text-[12px] outline-none focus:ring-[3px] focus:ring-ring/50"
                  />
                ) : null
              }
            />
          </div>
        ))}

        {/* Why: hidden while filtering. A wanted page is a name with no document
            behind it, so it can match nothing the operator typed, and showing it
            under "Nothing matches that" reads as a result. */}
        {query.trim() === '' ? (
          <BrainWantedPages
            pages={scan.wantedPages}
            totalCount={scan.wantedPageCount}
            onOpenDocument={onOpenDocument}
          />
        ) : null}
      </div>
    </div>
  )
}

/** Which section the reader is actually looking at, for the rail's highlight. */
function topmostSection(
  container: HTMLDivElement | null,
  refs: Map<string, HTMLDivElement>
): string | null {
  if (!container) {
    return null
  }
  const top = container.getBoundingClientRect().top
  let best: { path: string; distance: number } | null = null
  for (const [path, element] of refs) {
    const distance = element.getBoundingClientRect().top - top
    // Why: the last section whose top has passed the fold. A section still below
    // it is not what anyone is reading.
    if (distance <= 8 && (!best || distance > best.distance)) {
      best = { path, distance }
    }
  }
  return best?.path ?? [...refs.keys()][0] ?? null
}
