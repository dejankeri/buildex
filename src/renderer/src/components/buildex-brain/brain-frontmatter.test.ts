import { describe, expect, it } from 'vitest'
import { joinFrontmatter, splitFrontmatter } from './brain-frontmatter'

describe('splitFrontmatter', () => {
  it('holds back a skill header so the editor never sees it', () => {
    const text = '---\nname: onboard-client\ndescription: Do the thing\n---\n\n# Steps\n'
    const split = splitFrontmatter(text)

    expect(split.frontmatter).toBe('---\nname: onboard-client\ndescription: Do the thing\n---\n')
    expect(split.body).toBe('\n# Steps\n')
  })

  it('leaves an ordinary document alone', () => {
    const text = '# Pricing\n\nWe charge per seat.\n'
    expect(splitFrontmatter(text)).toEqual({ frontmatter: '', body: text })
  })

  it('does not mistake a horizontal rule mid-document for a header', () => {
    const text = '# Notes\n\n---\n\nMore.\n'
    expect(splitFrontmatter(text).frontmatter).toBe('')
  })

  it('treats an unterminated block as content, never as a header', () => {
    // Why: swallowing the whole file as front matter would show the operator an
    // empty document and then save that emptiness over their work.
    const text = '---\nname: half-written\n\n# Steps\n'
    expect(splitFrontmatter(text)).toEqual({ frontmatter: '', body: text })
  })

  it('puts the file back exactly as it was when nothing is edited', () => {
    const text = '---\nname: x\n---\nbody\n'
    const split = splitFrontmatter(text)
    expect(joinFrontmatter(split.frontmatter, split.body)).toBe(text)
  })

  it('survives CRLF line endings', () => {
    const text = '---\r\nname: x\r\n---\r\nbody\r\n'
    const split = splitFrontmatter(text)
    expect(split.frontmatter).toBe('---\r\nname: x\r\n---\r\n')
    expect(joinFrontmatter(split.frontmatter, split.body)).toBe(text)
  })
})
