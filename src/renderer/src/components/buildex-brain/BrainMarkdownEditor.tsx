import React, { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'

import { createRichMarkdownExtensions } from '@/components/editor/rich-markdown-extensions'
import { encodeRawMarkdownHtmlForRichEditor } from '@/components/editor/raw-markdown-html'
import { createRichMarkdownEditorCodec } from '@/components/editor/rich-markdown-source-transport'
import { LinearIssueMarkdownToolbar } from '@/components/LinearIssueMarkdownToolbar'
import {
  getRichMarkdownSpellcheckAttribute,
  useRichMarkdownSpellcheckAttribute
} from '@/components/editor/rich-markdown-spellcheck'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

// The rich markdown editor, pointed at a company document.
//
// This is Orca's own editor stack — the same extensions, codec and toolbar the
// issue editors use — so BuildEx ships no second markdown implementation. What
// is different is what it is editing: a file in `.buildex/` that git tracks.
//
// Mounted per document (`key` on the file path), so there is no reconciling
// between an external value and editor state. The file is read once, the editor
// owns it while it is open, and what comes back out is markdown.

export default function BrainMarkdownEditor({
  initialValue,
  onChange
}: {
  initialValue: string
  onChange: (markdown: string) => void
}): React.JSX.Element {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const editorRef = useRef<Editor | null>(null)
  const spellcheckEnabled = useAppStore((s) => s.settings?.richMarkdownSpellcheckEnabled ?? true)

  // Why: Tiptap freezes extension options at creation, and the codec keeps a
  // private Marked registry — both have to be rebuilt when the language changes.
  const codec = useMemo(() => {
    void language
    return createRichMarkdownEditorCodec()
  }, [language])

  const extensions = useMemo(() => {
    void language
    return [
      ...createRichMarkdownExtensions({ codec }),
      Placeholder.configure({
        placeholder: translate(
          'buildex.brain.editor.placeholder',
          'Write it the way you would explain it to someone joining tomorrow.'
        )
      })
    ]
  }, [codec, language])

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: true,
      extensions,
      content: encodeRawMarkdownHtmlForRichEditor(initialValue, codec),
      contentType: 'markdown',
      editorProps: {
        attributes: {
          class: 'rich-markdown-editor',
          spellcheck: getRichMarkdownSpellcheckAttribute(spellcheckEnabled),
          'aria-label': translate('buildex.brain.editor.label', 'Document')
        }
      },
      onFocus: () => {
        window.api.ui.setMarkdownEditorFocused(true)
      },
      onBlur: () => {
        window.api.ui.setMarkdownEditorFocused(false)
      },
      onUpdate: ({ editor: next }) => {
        onChange(next.getMarkdown())
      }
    },
    [codec, language]
  )
  useRichMarkdownSpellcheckAttribute(editor, spellcheckEnabled)
  editorRef.current = editor ?? null

  return (
    <div className="linear-issue-markdown-editor flex min-h-0 flex-1 flex-col">
      <LinearIssueMarkdownToolbar editor={editor} disabled={false} />
      <div className="linear-issue-markdown-scroll scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-6 text-[15px] leading-[1.7]">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  )
}
