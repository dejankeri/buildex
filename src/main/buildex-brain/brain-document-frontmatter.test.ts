import { describe, expect, it } from 'vitest'
import { readDocumentFrontmatter } from './brain-document-frontmatter'

describe('readDocumentFrontmatter', () => {
  it('reads a description and hands back the document without the block', () => {
    const result = readDocumentFrontmatter(
      '---\ndescription: Renewal is Q3.\n---\n\n# Acme\n\nBody.\n'
    )

    expect(result.description).toBe('Renewal is Q3.')
    expect(result.body).toBe('\n# Acme\n\nBody.\n')
  })

  it('says nothing about a document with no front matter, and leaves it whole', () => {
    // The regression that would silently degrade every brain written so far.
    const text = '# Acme\n\nBody.\n'

    expect(readDocumentFrontmatter(text)).toEqual({ description: '', body: text })
  })

  it('leaves a document that opens with a horizontal rule alone', () => {
    // An unterminated `---` is not front matter; treating it as one would hide
    // the whole file behind a block that never closes.
    const text = '---\n\n# Acme\n'

    expect(readDocumentFrontmatter(text)).toEqual({ description: '', body: text })
  })

  it('reads a description that sits beside other keys', () => {
    const result = readDocumentFrontmatter(
      '---\nname: acme\ndescription: The renewal terms.\nowner: dana\n---\nBody\n'
    )

    expect(result.description).toBe('The renewal terms.')
  })

  it('ignores an indented description, which belongs to some other key', () => {
    const result = readDocumentFrontmatter('---\nmeta:\n  description: nested\n---\nBody\n')

    expect(result.description).toBe('')
  })

  it('unquotes a value that had to be quoted to hold a colon', () => {
    const result = readDocumentFrontmatter(
      '---\ndescription: "Pricing: how we set it"\n---\nBody\n'
    )

    expect(result.description).toBe('Pricing: how we set it')
  })

  it('declines a folded scalar rather than reporting the indicator as the text', () => {
    const result = readDocumentFrontmatter('---\ndescription: >\n  spread over lines\n---\nBody\n')

    expect(result.description).toBe('')
  })

  it('cuts an overlong description at a word boundary', () => {
    const long = 'word '.repeat(60).trim()

    const result = readDocumentFrontmatter(`---\ndescription: ${long}\n---\nBody\n`)

    expect(result.description.length).toBeLessThanOrEqual(161)
    expect(result.description.endsWith('…')).toBe(true)
    expect(result.description).not.toContain('  ')
  })

  it('handles CRLF, since a brain can be written on Windows', () => {
    const result = readDocumentFrontmatter('---\r\ndescription: Windows.\r\n---\r\n# Acme\r\n')

    expect(result.description).toBe('Windows.')
    expect(result.body).toBe('# Acme\r\n')
  })
})
