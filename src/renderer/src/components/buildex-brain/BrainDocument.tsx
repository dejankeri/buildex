import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import BrainMarkdownEditor from './BrainMarkdownEditor'
import { joinFrontmatter, splitFrontmatter } from './brain-frontmatter'
import type { BrainOpenFile } from './use-brain'

// Writing a company document, in the Brain.
//
// The file on disk stays the artifact (invariant 3) — this edits markdown and
// writes markdown back. What the operator gets is the app's own rich editor
// rather than a code pane they have to navigate away to reach.
//
// Nothing is ever lost (invariant 8): edits save on ⌘S, on Back, and on unmount
// — the last through a ref, because a component that is going away cannot wait
// for its own state to settle first.

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export default function BrainDocument({
  file,
  onClose,
  onSaved
}: {
  file: BrainOpenFile
  onClose: () => void
  onSaved: () => void | Promise<void>
}): React.JSX.Element {
  /** The whole file as it was read — what "dirty" is measured against. */
  const [original, setOriginal] = useState<string | null>(null)
  const [frontmatter, setFrontmatter] = useState('')
  const [body, setBody] = useState('')
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)

  // What an unmount needs in order to write, without waiting on a render.
  const pending = useRef<{ absolutePath: string; content: string } | null>(null)
  const dirty = original !== null && joinFrontmatter(frontmatter, body) !== original

  useEffect(() => {
    let cancelled = false
    setOriginal(null)
    setState('idle')
    setError(null)
    void window.api.fs
      .readFile({ filePath: file.absolutePath })
      .then((result) => {
        if (cancelled) {
          return
        }
        const split = splitFrontmatter(result.content)
        setFrontmatter(split.frontmatter)
        setBody(split.body)
        setOriginal(result.content)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      cancelled = true
    }
  }, [file.absolutePath])

  const save = useCallback(async (): Promise<void> => {
    const draft = pending.current
    if (!draft) {
      return
    }
    pending.current = null
    setState('saving')
    try {
      await window.api.fs.writeFile({ filePath: draft.absolutePath, content: draft.content })
      setOriginal(draft.content)
      setState('saved')
      setError(null)
      await onSaved()
    } catch (cause) {
      // Why: put the draft back. A failed write that also dropped the edit would
      // lose the operator's words twice over.
      pending.current = draft
      setState('error')
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [onSaved])

  // Why: this cleanup runs when the document closes and when the Brain itself
  // goes away, so leaving by any route still writes what was typed.
  useEffect(() => {
    return () => {
      const draft = pending.current
      if (draft) {
        pending.current = null
        void window.api.fs.writeFile({ filePath: draft.absolutePath, content: draft.content })
      }
    }
  }, [])

  const edit = (markdown: string): void => {
    setBody(markdown)
    const next = joinFrontmatter(frontmatter, markdown)
    // Why: the editor emits an update as it takes the content in. Only a real
    // difference counts as an edit, or opening a document and leaving would
    // rewrite it — and reformat it in passing.
    pending.current = next === original ? null : { absolutePath: file.absolutePath, content: next }
    setState('idle')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <button
          type="button"
          onClick={() => {
            void save()
            onClose()
          }}
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-accent"
        >
          <ArrowLeft size={13} />
          {translate('buildex.brain.document.back', 'Back')}
        </button>
        <span className="min-w-0 truncate text-[13px] font-medium">{file.title}</span>
        <span className="hidden truncate text-[11px] text-muted-foreground/60 sm:inline">
          {file.relativePath}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <SaveStatus state={state} dirty={dirty} />
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || state === 'saving'}
            className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {translate('buildex.brain.document.save', 'Save')}
          </button>
        </div>
      </div>

      {error ? (
        <p className="shrink-0 border-b border-border px-4 py-1.5 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}

      {original === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 's') {
              event.preventDefault()
              void save()
            }
          }}
        >
          {/* Why: keyed on the path — a new document is a new editor, so there is
              nothing to reconcile between file and editor state. */}
          <BrainMarkdownEditor key={file.absolutePath} initialValue={body} onChange={edit} />
        </div>
      )}
    </div>
  )
}

function SaveStatus({ state, dirty }: { state: SaveState; dirty: boolean }): React.JSX.Element {
  if (state === 'saving') {
    return <Loader2 size={12} className="animate-spin text-muted-foreground" />
  }
  if (dirty) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-amber-500" />
        {translate('buildex.brain.document.unsaved', 'Unsaved')}
      </span>
    )
  }
  return (
    <span className="text-[11px] text-muted-foreground/60">
      {state === 'saved'
        ? translate('buildex.brain.document.saved', 'Saved')
        : translate('buildex.brain.document.hint', '⌘S to save')}
    </span>
  )
}
