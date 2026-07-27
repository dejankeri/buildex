import React, { useMemo, useState } from 'react'
import { Brain, Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import BrainDocument from './BrainDocument'
import BrainHistory from './BrainHistory'
import BrainSections from './BrainSections'
import BrainSkills from './BrainSkills'
import { useBrain } from './use-brain'

// The company brain, full screen.
//
// Everything here is derived from `.buildex/` and git — no model in the loop
// (invariant 9). Sections is where the work happens and so it lands first;
// skills and history are what that work produced.

type Tab = 'sections' | 'skills' | 'history'

export default function BrainPage(): React.JSX.Element {
  useTranslation()
  const {
    repoPath,
    scan,
    sections,
    history,
    loading,
    refresh,
    openFile,
    openDocument,
    openPath,
    closeFile
  } = useBrain()
  const [tab, setTab] = useState<Tab>('sections')

  const stats = useMemo(() => {
    const filled = new Set(scan.documents.map((document) => document.folder))
    return {
      documents: scan.documents.length,
      sectionsFilled: sections.filter((section) => filled.has(section.folder)).length,
      sectionsTotal: sections.length,
      unsaved: history.unsavedPaths.length
    }
  }, [history.unsavedPaths.length, scan, sections])

  const lastSave = history.saves[0] ?? null

  const tabs: { id: Tab; label: string }[] = [
    { id: 'sections', label: translate('buildex.brain.page.sections', 'Sections') },
    { id: 'skills', label: translate('buildex.brain.page.skills', 'Skills') },
    { id: 'history', label: translate('buildex.brain.page.history', 'History') }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Brain size={16} className="text-muted-foreground" />
        <h1 className="text-[14px] font-semibold tracking-tight">
          {translate('buildex.brain.page.title', 'Company Brain')}
        </h1>
        {loading ? <Loader2 size={13} className="animate-spin text-muted-foreground" /> : null}

        <div className="ml-auto flex items-center gap-1">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setTab(entry.id)
                // Leaving a document by tab still writes it — BrainDocument's
                // unmount is what saves.
                closeFile()
              }}
              aria-current={tab === entry.id ? 'page' : undefined}
              className={cn(
                'h-7 rounded-md px-2.5 text-[12px] font-medium transition-colors',
                tab === entry.id
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50'
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>

      {repoPath === null ? (
        <BrainEmpty
          title={translate('buildex.brain.page.noProject', 'No project open')}
          hint={translate(
            'buildex.brain.page.noProjectHint',
            'Open a project and its company brain lives in .buildex, versioned with the repo.'
          )}
        />
      ) : openFile ? (
        <BrainDocument file={openFile} onClose={closeFile} onSaved={refresh} />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-end gap-6 border-b border-border px-5 py-4">
            <Stat
              value={stats.documents}
              label={translate('buildex.brain.page.documents', 'documents')}
            />
            <Stat
              value={`${stats.sectionsFilled}/${stats.sectionsTotal}`}
              label={translate('buildex.brain.page.sectionsFilled', 'sections filled')}
            />
            <Stat
              value={stats.unsaved}
              label={translate('buildex.brain.page.unsaved', 'unsaved')}
              accent={stats.unsaved > 0}
            />

            <div className="ml-auto flex items-center gap-2">
              {lastSave ? (
                <span className="max-w-[22rem] truncate text-[11px] text-muted-foreground">
                  {translate('buildex.brain.page.lastSave', 'Last save · {{value0}}', {
                    value0: lastSave.subject
                  })}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => void refresh()}
                aria-label={translate('buildex.brain.page.rescan', 'Rescan')}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
              >
                <RefreshCw size={12} />
              </button>
            </div>
          </div>

          {tab === 'skills' ? (
            <BrainSkills repoPath={repoPath} onOpenPath={openPath} />
          ) : tab === 'sections' ? (
            <BrainSections
              scan={scan}
              sections={sections}
              repoPath={repoPath}
              onOpenDocument={openDocument}
              onCreated={refresh}
            />
          ) : (
            <BrainHistory
              history={history}
              repoPath={repoPath}
              onSaved={refresh}
              onOpenDocument={openDocument}
            />
          )}
        </>
      )}
    </div>
  )
}

function Stat({
  value,
  label,
  accent
}: {
  value: number | string
  label: string
  accent?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span
        className={cn(
          'text-[22px] leading-none font-semibold tabular-nums',
          accent && 'text-amber-500'
        )}
      >
        {value}
      </span>
      <span className="mt-1 text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}

function BrainEmpty({ title, hint }: { title: string; hint: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <Brain size={22} className="text-muted-foreground/40" />
      <p className="text-[13px] text-muted-foreground">{title}</p>
      <p className="max-w-sm text-[12px] text-muted-foreground/70">{hint}</p>
    </div>
  )
}
