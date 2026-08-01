import { describe, expect, it } from 'vitest'
import type { StoreEntry, StoreSegment } from '../../../../shared/buildex-store-types'
import { filterStoreEntries, matchesStoreQuery } from './store-entry-search'

function entry(overrides: {
  name: string
  displayName?: string
  description?: string
  keywords?: string[]
  segment?: StoreSegment
  summary?: string
}): StoreEntry {
  return {
    plugin: {
      name: overrides.name,
      displayName: overrides.displayName ?? overrides.name,
      description: overrides.description ?? '',
      category: null,
      author: null,
      homepage: null,
      keywords: overrides.keywords ?? [],
      source: { url: null, path: `./plugins/${overrides.name}` }
    },
    marketplaceId: 'official',
    marketplaceLabel: 'Official',
    segment: overrides.segment ?? 'software',
    curated: overrides.summary !== undefined,
    overlay:
      overrides.summary === undefined
        ? null
        : { pluginName: overrides.name, summary: overrides.summary },
    installed: false
  }
}

describe('matchesStoreQuery', () => {
  it('matches display name, description and keywords', () => {
    const stripe = entry({
      name: 'stripe-docs',
      displayName: 'Stripe',
      description: 'Integrate the payments API',
      keywords: ['billing', 'invoices']
    })
    expect(matchesStoreQuery(stripe, 'stripe')).toBe(true)
    expect(matchesStoreQuery(stripe, 'payments')).toBe(true)
    expect(matchesStoreQuery(stripe, 'invoices')).toBe(true)
    expect(matchesStoreQuery(stripe, 'notion')).toBe(false)
  })

  it('searches the overlay summary, because that is the text the card shows', () => {
    const linear = entry({
      name: 'linear',
      description: 'MCP server',
      summary: 'File and triage issues from a session'
    })
    expect(matchesStoreQuery(linear, 'triage')).toBe(true)
  })

  it('narrows on every token rather than widening', () => {
    const canva = entry({ name: 'canva', description: 'Brand check for designs' })
    expect(matchesStoreQuery(canva, 'canva brand')).toBe(true)
    expect(matchesStoreQuery(canva, 'canva stripe')).toBe(false)
  })

  it('matches everything on an empty or whitespace query', () => {
    const any = entry({ name: 'anything' })
    expect(matchesStoreQuery(any, '')).toBe(true)
    expect(matchesStoreQuery(any, '   ')).toBe(true)
  })
})

describe('filterStoreEntries', () => {
  it('reaches every segment at once, because there is one shelf', () => {
    // Our stripe is the operator's and stripe/ai's is the developer's; a search
    // for one name has to surface both without the operator having to know
    // which shelf either used to sit on.
    const matches = filterStoreEntries(
      [
        entry({ name: 'stripe-lookup', segment: 'business', description: 'stripe invoices' }),
        entry({ name: 'stripe-docs', segment: 'software', description: 'stripe api' }),
        entry({ name: 'playwright', segment: 'software', description: 'browsers' })
      ],
      'stripe'
    )

    expect(matches.map((match) => match.plugin.name)).toEqual(['stripe-lookup', 'stripe-docs'])
  })

  it('keeps the order main sorted the catalog into', () => {
    const entries = [
      entry({ name: 'zebra', segment: 'business' }),
      entry({ name: 'alpha', segment: 'software' })
    ]

    expect(filterStoreEntries(entries, '').map((match) => match.plugin.name)).toEqual([
      'zebra',
      'alpha'
    ])
  })
})
