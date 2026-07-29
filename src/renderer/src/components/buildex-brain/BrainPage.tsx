import React, { useMemo, useState } from 'react'
import { Brain, Eye, FolderOpen, Loader2, MoreHorizontal, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import BrainAgentView from './BrainAgentView'
import BrainDocument from './BrainDocument'
import BrainHistory from './BrainHistory'
import BrainPlacement from './BrainPlacement'
import BrainRemove from './BrainRemove'
import BrainSections from './BrainSections'
import BrainSetup from './BrainSetup'
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
    diverged,
    refresh,
    openFile,
    openDocument,
    openPath,
    closeFile,
    setUp,
    cloneBrain,
    disconnect
  } = useBrain()
  const [tab, setTab] = useState<Tab>('sections')
  const [agentViewOpen, setAgentViewOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

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

  // Why: the scan carries the repo it describes, so this is true only once THIS
  // repo has been looked at. Without it the setup screen flashes for a moment on
  // every open — offering to create a brain that is already there.
  const scanned = repoPath !== null && scan.repoPath === repoPath

  // A brain that cannot be resolved has nothing true to show: no sections, no
  // history, no setup screen. BrainPlacement is the only thing that renders.
  const blocked = scanned && scan.resolution !== null && scan.resolution.status !== 'ready'
  const brainRoot = scan.resolution?.status === 'ready' ? scan.resolution.location.root : null
  const brainLocation = scan.resolution?.status === 'ready' ? scan.resolution.location : null

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
          {!scanned || blocked || !scan.initialized
            ? null
            : tabs.map((entry) => (
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

      {diverged ? (
        <p className="shrink-0 border-b border-border bg-amber-500/10 px-5 py-2 text-[11px] text-amber-600 dark:text-amber-500">
          {translate(
            'buildex.brain.page.diverged',
            'This brain and the shared one have both changed. BuildEx will not merge a company\u2019s decisions \u2014 open the brain repo and reconcile them there.'
          )}
        </p>
      ) : null}

      {notice ? (
        <p className="shrink-0 border-b border-border bg-accent/40 px-5 py-2 text-[11px] text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {repoPath === null ? (
        <BrainEmpty
          title={translate('buildex.brain.page.noProject', 'No project open')}
          hint={translate(
            'buildex.brain.page.noProjectHint',
            'Open a project and its company brain lives in .buildex, versioned with the repo.'
          )}
        />
      ) : !scanned ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 size={16} className="animate-spin text-muted-foreground/50" />
        </div>
      ) : blocked ? (
        <BrainPlacement
          resolution={scan.resolution}
          onClone={async (targetPath) => {
            setNotice(null)
            await cloneBrain(targetPath)
          }}
          onDisconnect={async () => {
            setNotice(null)
            await disconnect()
          }}
        />
      ) : !scan.initialized ? (
        <BrainSetup
          sections={sections}
          onSetUp={async (folders, summary, placement) => {
            setNotice(null)
            await setUp(folders, summary, placement)
          }}
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

              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={translate('buildex.brain.page.more', 'More')}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                >
                  <MoreHorizontal size={13} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onSelect={() => setAgentViewOpen(true)}>
                    <Eye size={13} />
                    {translate('buildex.brain.page.viewAgent', 'What the agent sees')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      void window.api.shell.openInFileManager(brainRoot ?? repoPath)
                    }}
                  >
                    <FolderOpen size={13} />
                    {translate('buildex.brain.page.reveal', 'Open the brain folder')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setRemoveOpen(true)}>
                    <Trash2 size={13} />
                    {/* Why: an external brain is shared, and this button never
                        deletes one. Promising removal is promising the wrong
                        blast radius — the dialog already says so. */}
                    {brainLocation?.mode === 'external'
                      ? translate(
                          'buildex.brain.page.disconnect',
                          'Disconnect this repo from the brain'
                        )
                      : translate('buildex.brain.page.remove', 'Remove the company brain')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {tab === 'skills' ? (
            <BrainSkills repoPath={repoPath} brainRoot={brainRoot} onOpenPath={openPath} />
          ) : tab === 'sections' ? (
            <BrainSections
              scan={scan}
              sections={sections}
              repoPath={repoPath}
              brainRoot={brainRoot}
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

      {repoPath === null ? null : (
        <>
          <BrainAgentView
            repoPath={repoPath}
            open={agentViewOpen}
            onOpenChange={setAgentViewOpen}
          />
          <BrainRemove
            repoPath={repoPath}
            location={brainLocation}
            open={removeOpen}
            onOpenChange={setRemoveOpen}
            onRemoved={(backupPath) => {
              // Why: the backup path is the only thing here the operator cannot
              // work out for themselves, so it is the one thing worth saying.
              setNotice(
                backupPath
                  ? translate(
                      'buildex.brain.page.removedWithBackup',
                      'Brain removed. A copy of what was not yet saved is in {{value0}}',
                      { value0: backupPath }
                    )
                  : translate(
                      'buildex.brain.page.removed',
                      'Brain removed, and the removal was saved to history.'
                    )
              )
              closeFile()
              void refresh()
            }}
          />
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
