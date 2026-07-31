// Bounding prose the brain hands to somebody else.
//
// Three callers wanted the same two operations and had grown two-and-a-half
// copies of them between them: front matter cleaning a `description:`, the tree
// cutting an entity's summary, and the context map cutting both again to its own
// tighter budget. The rules are identical everywhere — collapse the whitespace,
// cut at a word rather than mid-syllable, do not leave a dangling comma in front
// of the ellipsis — so they live here once.
//
// The budgets themselves do not: each caller states its own, because what a
// screen can afford and what a file read in full at the start of every agent
// session can afford are different numbers.

/** One line, single-spaced. A value that was written across lines is not. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * At most `limit` characters, cut at a word boundary, with an ellipsis when
 * anything was dropped. Never mid-word, and never ending on the punctuation the
 * cut happened to land after.
 */
export function truncateAtWord(value: string, limit: number): string {
  if (value.length <= limit) {
    return value
  }
  const cut = value.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`
}
