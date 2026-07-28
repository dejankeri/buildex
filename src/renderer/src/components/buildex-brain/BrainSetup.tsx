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

/** Where the operator wants this repo's brain to live, chosen once at setup. */
export type BrainPlacementChoice =
  | { mode: 'embedded' }
  | { mode: 'external'; brainPath: string; remote?: string; writePointer: boolean }

export default function BrainSetup({
  sections,
  onSetUp
}: {
  sections: BrainSectionInfo[]
  onSetUp: (folders: string[], summary: string, placement: BrainPlacementChoice) => Promise<void>
}): React.JSX.Element {
  const [summary, setSummary] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [external, setExternal] = useState(false)
  const [brainPath, setBrainPath] = useState('')
  const [remote, setRemote] = useState('')
  const [writePointer, setWritePointer] = useState(true)

  const chosen = sections.map((section) => section.folder).filter((folder) => !excluded.has(folder))

  const placementValid =
    !external || (brainPath.trim().length > 0 && (!writePointer || remote.trim().length > 0))

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
    if (chosen.length === 0 || busy || !placementValid) {
      return
    }
    setBusy(true)
    try {
      const placement: BrainPlacementChoice = external
        ? {
            mode: 'external',
            brainPath: brainPath.trim(),
            ...(remote.trim() ? { remote: remote.trim() } : {}),
            writePointer
          }
        : { mode: 'embedded' }
      await onSetUp(chosen, summary.trim(), placement)
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
            'The brain is where this company keeps what it knows — decisions, rules, the skills it wrote. It can live in this repo, or in a repo of its own that every project shares.'
          )}
        </p>

        <p className="mt-7 text-[12px] font-medium">
          {translate('buildex.brain.setup.placementLabel', 'Where should it live?')}
        </p>
        <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <button
            type="button"
            role="radio"
            aria-checked={!external}
            onClick={() => setExternal(false)}
            className={cn(
              'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
              !external
                ? 'border-ring/60 bg-accent/50'
                : 'border-border bg-background hover:bg-accent/30'
            )}
          >
            <span
              className={cn(
                'text-[12px] font-medium',
                !external ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {translate('buildex.brain.setup.placementEmbedded', 'In this repo')}
            </span>
            <span className="mt-0.5 text-[11px] text-muted-foreground/80">
              {translate(
                'buildex.brain.setup.placementEmbeddedHint',
                'Lives in .buildex and travels with this repo alone.'
              )}
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={external}
            onClick={() => setExternal(true)}
            className={cn(
              'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
              external
                ? 'border-ring/60 bg-accent/50'
                : 'border-border bg-background hover:bg-accent/30'
            )}
          >
            <span
              className={cn(
                'text-[12px] font-medium',
                external ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {translate('buildex.brain.setup.placementExternal', 'In a separate brain repo')}
            </span>
            <span className="mt-0.5 text-[11px] text-muted-foreground/80">
              {translate(
                'buildex.brain.setup.placementExternalHint',
                'Shared with every repo that points at it.'
              )}
            </span>
          </button>
        </div>

        {external ? (
          <div className="mt-3 space-y-3 rounded-md border border-border bg-accent/20 p-3">
            <div>
              <label className="block text-[12px] font-medium" htmlFor="brain-setup-external-path">
                {translate('buildex.brain.setup.brainPathLabel', 'Path to the brain repo')}
              </label>
              <input
                id="brain-setup-external-path"
                value={brainPath}
                onChange={(event) => setBrainPath(event.target.value)}
                placeholder={translate(
                  'buildex.brain.setup.brainPathPlaceholder',
                  '/home/dev/.buildex/brains/acme'
                )}
                className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-[12px] outline-none focus:border-ring"
              />
            </div>

            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={writePointer}
                onChange={(event) => setWritePointer(event.target.checked)}
                className="size-3.5"
              />
              {translate(
                'buildex.brain.setup.writePointer',
                'Record this choice in the repo so teammates find it'
              )}
            </label>

            {writePointer ? (
              <div>
                <label
                  className="block text-[12px] font-medium"
                  htmlFor="brain-setup-external-remote"
                >
                  {translate('buildex.brain.setup.remoteLabel', "The brain repo's remote")}
                </label>
                <input
                  id="brain-setup-external-remote"
                  value={remote}
                  onChange={(event) => setRemote(event.target.value)}
                  placeholder={translate(
                    'buildex.brain.setup.remotePlaceholder',
                    'git@github.com:acme/brain.git'
                  )}
                  className="mt-2 h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-[12px] outline-none focus:border-ring"
                />
              </div>
            ) : null}
          </div>
        ) : null}

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
            disabled={chosen.length === 0 || busy || !placementValid}
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
