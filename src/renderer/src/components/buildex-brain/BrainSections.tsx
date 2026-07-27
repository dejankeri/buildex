import React, { useMemo, useState } from 'react'
import { FileText, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { BrainScan, BrainSectionInfo } from '../../../../shared/buildex-brain-types'

// Sections: browse the brain by area, and add to it.
//
// Coverage bars are the point of this view. A company with eleven decisions and
// nothing under People has a gap worth seeing, and a bar shows that faster than
// any number does.

const COVERAGE_STEPS = 4

function coverage(documentCount: number): number {
  // Why: not a percentage of anything — there is no "right" number of documents
  // for a section. It is a coarse "empty / thin / filling / solid".
  if (documentCount === 0) {
    return 0
  }
  if (documentCount <= 2) {
    return 1
  }
  if (documentCount <= 5) {
    return 2
  }
  if (documentCount <= 10) {
    return 3
  }
  return 4
}

export default function BrainSections({
  scan,
  sections,
  repoPath,
  onOpenDocument,
  onCreated
}: {
  scan: BrainScan
  sections: BrainSectionInfo[]
  repoPath: string | null
  onOpenDocument: (documentId: string) => void
  onCreated: () => void | Promise<void>
}): React.JSX.Element {
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  const byFolder = useMemo(() => {
    const map = new Map<string, BrainScan['documents']>()
    for (const document of scan.documents) {
      const bucket = map.get(document.folder) ?? []
      bucket.push(document)
      map.set(document.folder, bucket)
    }
    return map
  }, [scan.documents])

  // Declared sections first, in their declared order, then anything the company
  // added that BuildEx does not know about — never hide a folder someone made.
  const rows = useMemo(() => {
    const declared = sections.map((section) => ({
      folder: section.folder,
      title: section.title,
      purpose: section.purpose
    }))
    const known = new Set(declared.map((entry) => entry.folder))
    const extra = [...byFolder.keys()]
      .filter((folder) => !known.has(folder))
      .sort((a, b) => a.localeCompare(b))
      .map((folder) => ({ folder, title: folder || 'Root', purpose: '' }))
    return [...declared, ...extra]
  }, [byFolder, sections])

  const create = async (folder: string): Promise<void> => {
    const name = title.trim()
    if (!repoPath || !name) {
      setCreatingIn(null)
      return
    }
    const result = await window.api.buildexBrainSections.createDocument({
      repoPath,
      folder,
      title: name
    })
    setCreatingIn(null)
    setTitle('')
    if (!result.ok) {
      setError(result.error ?? 'Could not create the document')
      return
    }
    setError(null)
    await onCreated()
    if (result.documentId) {
      onOpenDocument(result.documentId)
    }
  }

  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-4">
      {error ? <p className="mb-3 text-[12px] text-destructive">{error}</p> : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {rows.map((row) => {
          const documents = (byFolder.get(row.folder) ?? [])
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
          const filled = coverage(documents.length)
          return (
            <section
              key={row.folder || 'root'}
              className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-xs"
            >
              <header className="flex items-baseline gap-2">
                <h2 className="text-[13px] font-semibold">{row.title}</h2>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {documents.length}
                </span>
                <span className="ml-auto flex gap-0.5" aria-hidden>
                  {Array.from({ length: COVERAGE_STEPS }, (_unused, index) => (
                    <span
                      key={index}
                      className={cn(
                        'h-1.5 w-3 rounded-[2px]',
                        index < filled ? 'bg-primary/70' : 'bg-muted-foreground/15'
                      )}
                    />
                  ))}
                </span>
              </header>

              {row.purpose ? (
                <p className="text-[11px] leading-snug text-muted-foreground/80">{row.purpose}</p>
              ) : null}

              <ul className="flex flex-col">
                {documents.map((document) => (
                  <li key={document.id}>
                    <button
                      type="button"
                      onClick={() => onOpenDocument(document.id)}
                      className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[12px] hover:bg-accent"
                    >
                      <FileText size={11} className="shrink-0 text-muted-foreground/50" />
                      <span className="min-w-0 flex-1 truncate">{document.name}</span>
                      {document.changed ? (
                        <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
                      ) : null}
                    </button>
                  </li>
                ))}
                {documents.length === 0 ? (
                  <li className="px-1 py-0.5 text-[12px] text-muted-foreground/50">
                    {translate('buildex.brain.sections.empty', 'Nothing here yet')}
                  </li>
                ) : null}
              </ul>

              {creatingIn === row.folder ? (
                <input
                  autoFocus
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={() => setCreatingIn(null)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void create(row.folder)
                    }
                    if (event.key === 'Escape') {
                      setCreatingIn(null)
                    }
                  }}
                  placeholder={translate('buildex.brain.sections.nameIt', 'Name it, then Enter')}
                  className="h-7 w-full rounded-md border border-input bg-background px-2 text-[12px] outline-none focus:ring-[3px] focus:ring-ring/50"
                />
              ) : (
                <button
                  type="button"
                  disabled={!repoPath}
                  onClick={() => {
                    setTitle('')
                    setCreatingIn(row.folder)
                  }}
                  className="inline-flex h-6 items-center gap-1 self-start rounded-md px-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-40"
                >
                  <Plus size={11} />
                  {translate('buildex.brain.sections.add', 'Add')}
                </button>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
