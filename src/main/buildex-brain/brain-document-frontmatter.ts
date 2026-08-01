// A brain document's front matter, read as data.
//
// One field: `description`, the line that turns a filename into a recall key.
// A map of filenames tells an agent what exists; a map of descriptions tells it
// which one to open — the same job `description:` does in a skill manifest and
// in Claude Code's own memory format.
//
// Optional throughout. A brain whose documents carry no front matter must render
// exactly as it did before this existed, so every absence returns an empty
// string and every caller treats that as "say nothing extra".
//
// Deliberately not a YAML parser. Front matter here is a handful of `key: value`
// lines an operator types by hand; a real parser would accept anchors, block
// scalars and nested maps that nothing downstream can render, and would throw on
// the half-written document that is exactly when this has to keep working.

import { collapseWhitespace, truncateAtWord } from './brain-text-budget'

/**
 * Longest a description gets as *data*. The Brain tree and its folder rows can
 * afford this; the context map cuts it again to its own tighter budget, because
 * that file is read in full at the start of every agent session.
 */
export const DESCRIPTION_LIMIT = 160

const BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
// No leading whitespace: an indented `description:` belongs to some other key.
const DESCRIPTION_RE = /^description:[ \t]*(.*)$/

export type DocumentFrontmatter = {
  /** The `description:` value, cleaned and bounded. `''` when there is none. */
  description: string
  /** The document with its front matter removed — what a summary should read. */
  body: string
}

function clean(raw: string): string {
  // A folded or literal scalar (`description: >`) puts the value on the lines
  // below, which is a shape this does not read rather than one it guesses at.
  const value = raw.trim()
  if (!value || value === '>' || value === '|') {
    return ''
  }
  const unquoted = /^(['"])([\s\S]*)\1$/.exec(value)?.[2] ?? value
  return truncateAtWord(collapseWhitespace(unquoted), DESCRIPTION_LIMIT)
}

export function readDocumentFrontmatter(text: string): DocumentFrontmatter {
  const match = BLOCK_RE.exec(text)
  if (!match) {
    // An unterminated `---` is a document that opens with a horizontal rule, not
    // front matter — the same call `brain-frontmatter.ts` makes in the editor.
    return { description: '', body: text }
  }
  const body = text.slice(match[0].length)
  for (const line of match[1].split('\n')) {
    const value = DESCRIPTION_RE.exec(line)?.[1]
    if (value !== undefined) {
      return { description: clean(value), body }
    }
  }
  return { description: '', body }
}
