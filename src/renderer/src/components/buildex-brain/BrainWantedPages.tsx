import React from 'react'
import { translate } from '@/i18n/i18n'
import type { BrainWantedPage } from '../../../../shared/buildex-brain-types'

// What the brain says it should know and does not.
//
// Every entry got here because somebody wrote `[[a-name]]` while writing
// something else — the moment a gap is most obvious and least convenient to fill.
// Listing them turns that into a backlog instead of a dead link.
//
// Last on the page on purpose: it is a queue, not an area of the company, and it
// must never compete with the sections somebody came here to read.

/** Bounded like the context map's copy of this list, and for the same reason. */
const SHOWN = 12
const REQUESTERS_SHOWN = 3

export default function BrainWantedPages({
  pages,
  onOpenDocument
}: {
  pages: BrainWantedPage[]
  onOpenDocument: (documentId: string) => void
}): React.JSX.Element | null {
  if (pages.length === 0) {
    return null
  }
  const shown = pages.slice(0, SHOWN)
  const hidden = pages.length - shown.length

  return (
    <section className="flex flex-col gap-2 py-4">
      <header className="flex items-center gap-2">
        <h2 className="text-[11px] font-semibold tracking-[0.05em] uppercase">
          {translate('buildex.brain.wanted.title', 'Wanted pages')}
        </h2>
        <span className="text-[11px] tabular-nums text-muted-foreground/70">{pages.length}</span>
      </header>

      <p className="text-[11px] leading-snug text-muted-foreground/80">
        {translate(
          'buildex.brain.wanted.hint',
          'Named by a link somewhere in the brain, and not written yet.'
        )}
      </p>

      <ul className="flex flex-col gap-0.5">
        {shown.map((page) => (
          <li key={page.name} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="min-w-0 truncate font-mono text-[12px]">{page.name}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {page.requestedBy.slice(0, REQUESTERS_SHOWN).map((documentId) => (
                <button
                  key={documentId}
                  type="button"
                  onClick={() => onOpenDocument(documentId)}
                  className="max-w-[14rem] truncate rounded-md px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                >
                  {documentId}
                </button>
              ))}
              {page.requestedBy.length > REQUESTERS_SHOWN ? (
                <span className="text-[11px] text-muted-foreground/60">
                  {translate('buildex.brain.wanted.moreAskers', '+{{value0}} more', {
                    value0: page.requestedBy.length - REQUESTERS_SHOWN
                  })}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>

      {hidden > 0 ? (
        <p className="text-[11px] text-muted-foreground/60">
          {translate('buildex.brain.wanted.morePages', '+{{value0}} more wanted', {
            value0: hidden
          })}
        </p>
      ) : null}
    </section>
  )
}
