import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { NativeChatDiffView } from '@/components/native-chat/NativeChatDiffView'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  BrainDiffStatus,
  BrainSaveDiffFile,
  BrainSaveDiffResult
} from '../../../../shared/buildex-brain-types'

// What one save changed. The lines arrive already classified from main, and
// NativeChatDiffView renders them — the same coloured diff the agent's own tool
// calls use, so a night's writing reads the same wherever the operator meets it.

const STATUS_TOKEN: Record<BrainDiffStatus, string> = {
  added: 'text-[var(--git-decoration-added)]',
  modified: 'text-[var(--git-decoration-modified)]',
  deleted: 'text-[var(--git-decoration-deleted)]',
  renamed: 'text-[var(--git-decoration-renamed)]',
  copied: 'text-[var(--git-decoration-copied)]',
  changed: 'text-muted-foreground'
}

function statusLabel(status: BrainDiffStatus): string {
  switch (status) {
    case 'added':
      return translate('buildex.brain.diff.added', 'added')
    case 'modified':
      return translate('buildex.brain.diff.modified', 'changed')
    case 'deleted':
      return translate('buildex.brain.diff.deleted', 'deleted')
    case 'renamed':
      return translate('buildex.brain.diff.renamed', 'renamed')
    case 'copied':
      return translate('buildex.brain.diff.copied', 'copied')
    case 'changed':
      return translate('buildex.brain.diff.changed', 'changed')
  }
}

function DiffFile({ file }: { file: BrainSaveDiffFile }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
        <span className={cn('shrink-0 font-medium', STATUS_TOKEN[file.status])}>
          {statusLabel(file.status)}
        </span>
        <span className="min-w-0 break-all font-mono text-muted-foreground">
          {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        </span>
      </div>
      {file.binary ? (
        <p className="text-[11px] text-muted-foreground/70">
          {translate(
            'buildex.brain.diff.binary',
            'Not text — there is nothing to show line by line.'
          )}
        </p>
      ) : file.lines.length > 0 ? (
        <NativeChatDiffView lines={file.lines} />
      ) : null}
      {file.truncated ? (
        <p className="text-[11px] text-muted-foreground/70">
          {translate('buildex.brain.diff.truncated', 'Long diff — the rest is in the document.')}
        </p>
      ) : null}
    </div>
  )
}

export default function BrainSaveDiff({
  repoPath,
  hash
}: {
  repoPath: string | null
  hash: string
}): React.JSX.Element {
  const [diff, setDiff] = useState<BrainSaveDiffResult | null>(null)

  useEffect(() => {
    if (!repoPath) {
      return
    }
    let cancelled = false
    setDiff(null)
    void window.api.buildexBrainSections.saveDiff({ repoPath, hash }).then((result) => {
      if (!cancelled) {
        setDiff(result)
      }
    })
    return () => {
      cancelled = true
    }
  }, [repoPath, hash])

  // No repo is not "still loading": a spinner that can never resolve reads as a
  // hang rather than as the answer it is.
  if (!repoPath) {
    return (
      <p className="py-2 text-[11px] text-muted-foreground">
        {translate('buildex.brain.diff.unavailable', 'This save could not be read from git.')}
      </p>
    )
  }
  if (!diff) {
    return (
      <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground">
        <Loader2 size={11} className="animate-spin" />
        {translate('buildex.brain.diff.loading', 'Reading this save…')}
      </div>
    )
  }
  if (diff.unavailable) {
    return (
      <p className="py-2 text-[11px] text-muted-foreground">
        {translate('buildex.brain.diff.unavailable', 'This save could not be read from git.')}
      </p>
    )
  }
  if (diff.files.length === 0) {
    return (
      <p className="py-2 text-[11px] text-muted-foreground">
        {translate('buildex.brain.diff.empty', 'This save changed nothing in the brain.')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3 py-2">
      {diff.files.map((file) => (
        <DiffFile key={`${file.previousPath ?? ''}:${file.path}`} file={file} />
      ))}
      {diff.truncated ? (
        <p className="text-[11px] text-muted-foreground/70">
          {translate('buildex.brain.diff.moreFiles', 'More files changed than are shown here.')}
        </p>
      ) : null}
    </div>
  )
}
