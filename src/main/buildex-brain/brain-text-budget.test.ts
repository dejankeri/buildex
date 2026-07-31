import { describe, expect, it } from 'vitest'
import { collapseWhitespace, truncateAtWord } from './brain-text-budget'

// Three callers depend on the exact contract here — front matter, the tree's
// summary, and the context map's tighter budget — so it is pinned once rather
// than re-asserted three times through them.

describe('collapseWhitespace', () => {
  it('puts a value written across lines back onto one', () => {
    expect(collapseWhitespace('renewal\n  terms\tand rates')).toBe('renewal terms and rates')
  })

  it('trims the ends', () => {
    expect(collapseWhitespace('  spaced  ')).toBe('spaced')
  })

  it('leaves an empty value empty rather than inventing a space', () => {
    expect(collapseWhitespace('   \n  ')).toBe('')
  })
})

describe('truncateAtWord', () => {
  it('returns a value already within budget untouched, with no ellipsis', () => {
    expect(truncateAtWord('Renewal is Q3.', 40)).toBe('Renewal is Q3.')
  })

  it('cuts at a word boundary rather than mid-word', () => {
    expect(truncateAtWord('alpha beta gamma delta', 14)).toBe('alpha beta…')
  })

  it('does not leave a dangling comma in front of the ellipsis', () => {
    // The boundary lands right after `beta,` — the comma goes with the cut.
    expect(truncateAtWord('alpha beta, gamma delta', 13)).toBe('alpha beta…')
  })

  it('cuts mid-word when there is no word boundary to cut at', () => {
    expect(truncateAtWord('a'.repeat(50), 10)).toBe(`${'a'.repeat(10)}…`)
  })

  it('never exceeds the budget it was given, ellipsis included', () => {
    const result = truncateAtWord('word '.repeat(80).trim(), 40)

    expect(result.length).toBeLessThanOrEqual(40)
    expect(result.endsWith('…')).toBe(true)
  })

  it('is exact at the boundary', () => {
    expect(truncateAtWord('abcde', 5)).toBe('abcde')
    expect(truncateAtWord('abcdef', 5)).toBe('abcde…')
  })
})
