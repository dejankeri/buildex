import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cachedMarketplaceIds,
  clearCachedIndex,
  INDEX_STALE_AFTER_MS,
  isIndexStale,
  oldestFetchedAt,
  readCachedIndex,
  writeCachedIndex
} from './marketplace-index-cache'

const roots: string[] = []

function userData(): string {
  const created = mkdtempSync(path.join(tmpdir(), 'buildex-index-cache-'))
  roots.push(created)
  return created
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('the marketplace index cache', () => {
  it('round-trips an index with the time it was fetched', () => {
    const root = userData()

    expect(writeCachedIndex(root, 'protocol', '{"name":"protocol"}', 1_700_000_000_000)).toBe(true)

    expect(readCachedIndex(root, 'protocol')).toEqual({
      body: '{"name":"protocol"}',
      fetchedAt: 1_700_000_000_000
    })
  })

  it('reports nothing for a marketplace never fetched', () => {
    // Why: this is what tells the Store to go and get it, rather than that the
    // product has nothing to offer.
    expect(readCachedIndex(userData(), 'never-fetched')).toBeNull()
  })

  it('refuses an id that would walk out of the cache directory', () => {
    const root = userData()

    expect(writeCachedIndex(root, '../escape', '{}', 1)).toBe(false)
    expect(readCachedIndex(root, '../escape')).toBeNull()
  })

  it('treats an unreadable entry as never fetched rather than throwing', () => {
    const root = userData()
    mkdirSync(path.join(root, 'marketplace-index'), { recursive: true })
    writeFileSync(path.join(root, 'marketplace-index', 'broken.json'), '{ not json')

    expect(readCachedIndex(root, 'broken')).toBeNull()
  })

  it('ignores an entry missing the fields that make it usable', () => {
    const root = userData()
    mkdirSync(path.join(root, 'marketplace-index'), { recursive: true })
    writeFileSync(path.join(root, 'marketplace-index', 'partial.json'), '{"body":"x"}')

    expect(readCachedIndex(root, 'partial')).toBeNull()
  })

  it('lists and clears what it holds', () => {
    const root = userData()
    writeCachedIndex(root, 'one', '{}', 1)
    writeCachedIndex(root, 'two', '{}', 2)

    expect(cachedMarketplaceIds(root)).toEqual(['one', 'two'])

    clearCachedIndex(root, 'one')

    expect(cachedMarketplaceIds(root)).toEqual(['two'])
    expect(existsSync(path.join(root, 'marketplace-index', 'one.json'))).toBe(false)
  })
})

describe('freshness', () => {
  it('reports the oldest fetch, because the shelf is only as current as its stalest part', () => {
    // One marketplace silently failing to refresh is exactly the case worth
    // surfacing, and taking the newest would hide it.
    expect(
      oldestFetchedAt([
        { body: '{}', fetchedAt: 500 },
        { body: '{}', fetchedAt: 100 },
        { body: '{}', fetchedAt: 900 }
      ])
    ).toBe(100)
  })

  it('reports nothing when no marketplace has ever been fetched', () => {
    expect(oldestFetchedAt([null, null])).toBeNull()
  })

  it('skips a marketplace that has never been fetched when others have', () => {
    expect(oldestFetchedAt([null, { body: '{}', fetchedAt: 42 }])).toBe(42)
  })

  it('treats never-fetched as stale, so the Store goes and gets it', () => {
    expect(isIndexStale(null, 1_000)).toBe(true)
  })

  it('is fresh inside the window and stale outside it', () => {
    const fetchedAt = 1_000_000
    expect(isIndexStale(fetchedAt, fetchedAt + INDEX_STALE_AFTER_MS - 1)).toBe(false)
    expect(isIndexStale(fetchedAt, fetchedAt + INDEX_STALE_AFTER_MS)).toBe(true)
  })
})
