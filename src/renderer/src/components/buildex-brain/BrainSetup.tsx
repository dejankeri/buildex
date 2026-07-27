import React, { useState } from 'react'
import { Brain, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { BrainSectionInfo } from '../../../../shared/buildex-brain-types'

// The first screen a repo with no company brain shows.
//
// BuildEx used to write the sections the moment any of its surfaces was touched,
// which meant a repo somebody opened to browse the Store came back with a dozen
// files in it. Setting up is now something the operator does on purpose.
//
// The one free-text line is not a form field. It replaces the placeholder in
// `strategy/overview.md`, so the brain's first document arrives already answered
// rather than asking a question nobody comes back to.

export default function BrainSetup({
  sections,
  onSetUp
}: {
  sections: BrainSectionInfo[]
  onSetUp: (folders: string[], summary: string) => Promise<void>
}): React.JSX.Element {
  const [summary, setSummary] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const chosen = sections.map((section) => section.folder).filter((folder) => !excluded.has(folder))

  const toggle = (folder: string): void => {
    setExcluded((current) => {
      const next = new Set(current)
      if (!next.delete(folder)) {
        next.add(folder)
      }
      return next
    })
  }

  const submit = async (): Promise<void> => {
    if (chosen.length === 0 || busy) {
      return
    }
    setBusy(true)
    try {
      await onSetUp(chosen, summary.trim())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-2">
          <Brain size={18} className="text-muted-foreground" />
          <h2 className="text-[15px] font-semibold tracking-tight">
            {translate('buildex.brain.setup.title', 'Set up your company brain')}
          </h2>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {translate(
            'buildex.brain.setup.intro',
            'The brain is where this company keeps what it knows — decisions, rules, the skills it wrote. It lives in .buildex and is versioned with the repo, so it travels with the team.'
          )}
        </p>

        <label className="mt-7 block text-[12px] font-medium" htmlFor="brain-setup-summary">
          {translate('buildex.brain.setup.summaryLabel', 'What does this company do?')}
        </label>
        <input
          id="brain-setup-summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void submit()
            }
          }}
          placeholder={translate(
            'buildex.brain.setup.summaryPlaceholder',
            'One line a stranger would understand.'
          )}
          className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 text-[13px] outline-none focus:border-ring"
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {translate(
            'buildex.brain.setup.summaryHint',
            'This becomes the first line of strategy/overview.md. Leave it blank and the document asks you instead.'
          )}
        </p>

        <p className="mt-7 text-[12px] font-medium">
          {translate('buildex.brain.setup.sectionsLabel', 'Sections to start with')}
        </p>
        <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {sections.map((section) => {
            const on = !excluded.has(section.folder)
            return (
              <button
                key={section.folder}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(section.folder)}
                className={cn(
                  'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
                  on
                    ? 'border-ring/60 bg-accent/50'
                    : 'border-border bg-background hover:bg-accent/30'
                )}
              >
                <span
                  className={cn(
                    'text-[12px] font-medium',
                    on ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {section.title}
                </span>
                <span className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/80">
                  {section.purpose}
                </span>
              </button>
            )
          })}
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={chosen.length === 0 || busy}
            className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            {translate('buildex.brain.setup.create', 'Create the brain')}
          </button>
          <span className="text-[11px] text-muted-foreground">
            {translate(
              'buildex.brain.setup.reassurance',
              'You can add, rename or remove any of these later.'
            )}
          </span>
        </div>
      </div>
    </div>
  )
}
