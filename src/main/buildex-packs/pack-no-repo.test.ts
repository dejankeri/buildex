import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findCatalogRoots, isPackInstalled, readPackCatalog } from './pack-catalog'

// First launch: BuildEx is open, no project has been added yet. The Store must
// still show what the product can do — an empty shelf reads as "this app has
// nothing to offer", which is the opposite of true.

let bundle = ''

beforeEach(() => {
  bundle = mkdtempSync(path.join(tmpdir(), 'buildex-norepo-'))
  mkdirSync(path.join(bundle, 'slack', 'skills', 'slack-search'), { recursive: true })
  writeFileSync(
    path.join(bundle, 'slack', 'pack.json'),
    JSON.stringify({ id: 'slack', name: 'Slack', skills: ['slack-search'] }),
    'utf8'
  )
  writeFileSync(path.join(bundle, 'slack', 'skills', 'slack-search', 'SKILL.md'), '# s', 'utf8')
})

afterEach(() => {
  rmSync(bundle, { recursive: true, force: true })
})

describe('catalog with no project open', () => {
  it('still shows the packs BuildEx ships', () => {
    const catalog = readPackCatalog('', bundle)

    expect(catalog.packs.map((pack) => pack.id)).toEqual(['slack'])
  })

  it('reports every pack as not installed', () => {
    expect(readPackCatalog('', bundle).packs[0].installed).toBe(false)
  })

  it('never resolves a catalog path relative to the working directory', () => {
    // path.join('', 'catalog') is the relative path 'catalog', which would
    // resolve against wherever the app happens to be running from.
    expect(findCatalogRoots('')).toEqual([])
    expect(isPackInstalled('', ['slack-search'])).toBe(false)
  })
})
