import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreMarketplace } from '../../shared/buildex-store-types'

const fetchMock = vi.fn()
vi.mock('electron', () => ({ net: { fetch: (...args: unknown[]) => fetchMock(...args) } }))

const { fetchMarketplaceIndex, marketplaceIndexUrl, refreshMarketplaceIndexes } =
  await import('./marketplace-fetch')
const { readCachedIndex } = await import('./marketplace-index-cache')

const roots: string[] = []

function userData(): string {
  const created = mkdtempSync(path.join(tmpdir(), 'buildex-fetch-'))
  roots.push(created)
  return created
}

function marketplace(id: string, repo: string): StoreMarketplace {
  return { id, label: id, repo, origin: 'bundled', defaultSegment: 'software' }
}

/** A minimal Response stand-in, with a cancellable body like the real one. */
function response(
  body: string,
  init: { ok?: boolean; status?: number; statusText?: string; contentLength?: string } = {}
): unknown {
  const cancel = vi.fn().mockResolvedValue(undefined)
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: {
      get: (name: string) => (name === 'content-length' ? (init.contentLength ?? null) : null)
    },
    body: { cancel },
    text: async () => body
  }
}

beforeEach(() => {
  fetchMock.mockReset()
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('marketplaceIndexUrl', () => {
  it('points at the marketplace manifest in the repo’s default branch', () => {
    // HEAD rather than a branch name: `main` and `master` are both in the wild.
    expect(marketplaceIndexUrl('anthropics/claude-plugins-official')).toBe(
      'https://raw.githubusercontent.com/anthropics/claude-plugins-official/HEAD/.claude-plugin/marketplace.json'
    )
  })

  it('takes an https URL for a company hosting its own', () => {
    expect(marketplaceIndexUrl('https://acme.example/marketplace.json')).toBe(
      'https://acme.example/marketplace.json'
    )
  })

  it('refuses anything else', () => {
    expect(marketplaceIndexUrl('http://insecure.example/m.json')).toBeNull()
    expect(marketplaceIndexUrl('../../etc/passwd')).toBeNull()
    expect(marketplaceIndexUrl('not a repo')).toBeNull()
  })
})

describe('fetchMarketplaceIndex', () => {
  it('returns the body on success', async () => {
    fetchMock.mockResolvedValue(response('{"name":"x","plugins":[]}'))

    expect(await fetchMarketplaceIndex('owner/repo')).toEqual({
      body: '{"name":"x","plugins":[]}'
    })
  })

  it('cancels the body on a failure response', async () => {
    // Why: an unread body pauses the HTTP parser and can take the process down —
    // the reason this repo bans bare global fetch outright.
    const failure = response('', { ok: false, status: 404, statusText: 'Not Found' }) as {
      body: { cancel: ReturnType<typeof vi.fn> }
    }
    fetchMock.mockResolvedValue(failure)

    expect(await fetchMarketplaceIndex('owner/repo')).toEqual({ error: '404 Not Found' })
    expect(failure.body.cancel).toHaveBeenCalled()
  })

  it('reports a network error rather than throwing', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))

    expect(await fetchMarketplaceIndex('owner/repo')).toEqual({
      error: 'getaddrinfo ENOTFOUND'
    })
  })

  it('refuses an implausibly large index by its declared length', async () => {
    const huge = response('{}', { contentLength: String(64 * 1024 * 1024) }) as {
      body: { cancel: ReturnType<typeof vi.fn> }
    }
    fetchMock.mockResolvedValue(huge)

    expect(await fetchMarketplaceIndex('owner/repo')).toEqual({
      error: 'Index is implausibly large'
    })
    expect(huge.body.cancel).toHaveBeenCalled()
  })

  it('does not attempt a URL it cannot build', async () => {
    expect(await fetchMarketplaceIndex('nonsense')).toEqual({
      error: 'Not a marketplace this can fetch: nonsense'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('refreshMarketplaceIndexes', () => {
  it('caches every index it could fetch', async () => {
    const root = userData()
    fetchMock.mockResolvedValue(response('{"name":"a","plugins":[]}'))

    const outcomes = await refreshMarketplaceIndexes(
      root,
      [marketplace('a', 'o/a'), marketplace('b', 'o/b')],
      1234
    )

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true)
    expect(readCachedIndex(root, 'a')?.fetchedAt).toBe(1234)
    expect(readCachedIndex(root, 'b')?.body).toBe('{"name":"a","plugins":[]}')
  })

  it('lets one marketplace fail without taking the others down', async () => {
    // A company marketplace behind a VPN must not stop Anthropic's refreshing.
    const root = userData()
    fetchMock
      .mockResolvedValueOnce(response('{"name":"a","plugins":[]}'))
      .mockRejectedValueOnce(new Error('unreachable'))

    const outcomes = await refreshMarketplaceIndexes(
      root,
      [marketplace('a', 'o/a'), marketplace('b', 'o/b')],
      99
    )

    expect(outcomes).toEqual([
      { marketplaceId: 'a', ok: true },
      { marketplaceId: 'b', ok: false, error: 'unreachable' }
    ])
    expect(readCachedIndex(root, 'a')).not.toBeNull()
    expect(readCachedIndex(root, 'b')).toBeNull()
  })

  it('leaves a previously cached index in place when a refresh fails', async () => {
    // A refresh that cannot reach the network leaves the operator the shelf they
    // already had, rather than emptying it.
    const root = userData()
    fetchMock.mockResolvedValueOnce(response('{"name":"old","plugins":[]}'))
    await refreshMarketplaceIndexes(root, [marketplace('a', 'o/a')], 1)

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await refreshMarketplaceIndexes(root, [marketplace('a', 'o/a')], 2)

    expect(readCachedIndex(root, 'a')).toEqual({
      body: '{"name":"old","plugins":[]}',
      fetchedAt: 1
    })
  })
})
