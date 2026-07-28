import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBrainDocument, toDocumentFileName } from './brain-document-create'
import { embeddedLocation } from './brain-location'

let repo = ''

function location() {
  return embeddedLocation(repo)
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-newdoc-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('toDocumentFileName', () => {
  it('turns what the operator typed into a filename', () => {
    expect(toDocumentFileName('Q3 pricing')).toBe('q3-pricing.md')
    expect(toDocumentFileName('  Why we said no  ')).toBe('why-we-said-no.md')
  })

  it('refuses a title with nothing usable in it', () => {
    expect(toDocumentFileName('///')).toBeNull()
    expect(toDocumentFileName('   ')).toBeNull()
  })

  it('cannot produce a path', () => {
    // The whole point: no title can walk out of the folder it was created in.
    expect(toDocumentFileName('../../etc/passwd')).toBe('etc-passwd.md')
    expect(toDocumentFileName('a/b/c')).toBe('a-b-c.md')
  })
})

describe('createBrainDocument', () => {
  it('writes the document and reports its brain id', () => {
    const result = createBrainDocument(location(), 'strategy', 'Q3 pricing')

    expect(result).toMatchObject({ ok: true, documentId: 'strategy/q3-pricing.md' })
    expect(readFileSync(path.join(repo, '.buildex/strategy/q3-pricing.md'), 'utf8')).toBe(
      '# Q3 pricing\n\n'
    )
  })

  it('rejects a section that is not one of ours', () => {
    const result = createBrainDocument(location(), '../../..', 'Escape')

    expect(result.ok).toBe(false)
    expect(existsSync(path.join(repo, '.buildex'))).toBe(false)
  })

  it('never overwrites an existing document', () => {
    createBrainDocument(location(), 'strategy', 'Pricing')
    const second = createBrainDocument(location(), 'strategy', 'Pricing')

    expect(second.ok).toBe(false)
    expect(second.error).toContain('Already exists')
  })

  it('accepts the brain root', () => {
    expect(createBrainDocument(location(), '', 'Readme').documentId).toBe('readme.md')
  })
})
