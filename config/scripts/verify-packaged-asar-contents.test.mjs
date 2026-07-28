import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  findForbiddenRootEntries,
  verifyPackagedAsarContents,
  MAX_ASAR_BYTES
} = require('./verify-packaged-asar-contents.cjs')

describe('findForbiddenRootEntries', () => {
  it('passes a normal packaged root', () => {
    expect(findForbiddenRootEntries(['out', 'resources', 'package.json', 'LICENSE'])).toEqual([])
  })

  // Why: v0.1.7 shipped this repo's .claude/ — settings plus a generated
  // company-context.md naming a local path — inside the public DMG.
  it('catches agent config and the company brain', () => {
    expect(findForbiddenRootEntries(['out', '.claude', '.buildex', '.mcp.json'])).toEqual([
      '.claude',
      '.buildex',
      '.mcp.json'
    ])
  })

  // Why: the real incident was a folder named dist-0.1.6-old, not dist.
  it('catches release output under any dist- spelling', () => {
    expect(findForbiddenRootEntries(['out', 'dist', 'dist-0.1.6-old', 'dist-backup'])).toEqual([
      'dist',
      'dist-0.1.6-old',
      'dist-backup'
    ])
  })

  it('does not confuse a legitimate entry that merely starts with the same letters', () => {
    expect(findForbiddenRootEntries(['distributed-runtime', 'buildex.json'])).toEqual([])
  })

  it('catches local test and evidence output that .gitignore does not exclude', () => {
    expect(findForbiddenRootEntries(['test-results', 'pr-evidence', 'coverage'])).toEqual([
      'test-results',
      'pr-evidence',
      'coverage'
    ])
  })
})

describe('verifyPackagedAsarContents', () => {
  let resourcesDir

  beforeEach(() => {
    resourcesDir = mkdtempSync(join(tmpdir(), 'buildex-asar-verify-'))
  })

  afterEach(() => {
    rmSync(resourcesDir, { recursive: true, force: true })
  })

  // Why: the 4.4 GB sweep-in was signed and notarized before anything noticed.
  // The size gate fails before that cost is paid, without reading the archive.
  it('fails an oversized asar', () => {
    const asarPath = join(resourcesDir, 'app.asar')
    writeFileSync(asarPath, Buffer.alloc(64))
    // Sparse file: costs no disk, still reports a size over the ceiling.
    truncateSync(asarPath, MAX_ASAR_BYTES + 1)

    expect(() => verifyPackagedAsarContents(resourcesDir)).toThrow(/over the .* GB ceiling/)
  })

  it('fails loudly when app.asar is missing rather than passing silently', () => {
    expect(() => verifyPackagedAsarContents(resourcesDir)).toThrow()
  })
})
