import { describe, expect, it } from 'vitest'
import type { StoreOverlay, StoreSegment } from '../../shared/buildex-store-types'
import {
  installKey,
  KNOWN_MARKETPLACES,
  readStoreCatalog,
  type StoreMarketplaceSource
} from './marketplace-catalog'

/** The index bodies a run has, keyed by marketplace id. */
type IndexBodies = Record<string, unknown>

function indexRoot(indexes: IndexBodies): IndexBodies {
  return indexes
}

function source(
  id: string,
  indexes: IndexBodies,
  defaultSegment: StoreSegment = 'software'
): StoreMarketplaceSource {
  return {
    id,
    label: id,
    repo: `owner/${id}`,
    origin: 'bundled',
    defaultSegment,
    indexBody: id in indexes ? JSON.stringify(indexes[id]) : null
  }
}

function marketplace(name: string, plugins: unknown[]): unknown {
  return { name, plugins }
}

function plugin(name: string, category: string | null = null): unknown {
  return { name, description: `${name} description`, category, source: `./plugins/${name}` }
}

describe('readStoreCatalog', () => {
  it('puts every marketplace on one shelf, tagged with where it came from', () => {
    const root = indexRoot({
      'claude-plugins-official': marketplace('claude-plugins-official', [
        plugin('clickhouse', 'database')
      ]),
      'buildex-packs': marketplace('buildex-packs', [plugin('stripe')])
    })

    const catalog = readStoreCatalog({
      marketplaces: [
        source('claude-plugins-official', root),
        source('buildex-packs', root, 'business')
      ],
      overlays: [],
      installed: new Set()
    })

    // Nothing is curated here, so the shelf is one alphabetical list rather than
    // one block per marketplace — a company should not have to know which
    // marketplace an app came from to find it.
    expect(catalog.entries.map((entry) => [entry.plugin.name, entry.marketplaceId])).toEqual([
      ['clickhouse', 'claude-plugins-official'],
      ['stripe', 'buildex-packs']
    ])
  })

  it('reads installed state in the plugin@marketplace form the agent records', () => {
    const root = indexRoot({
      official: marketplace('official', [plugin('stripe'), plugin('notion')])
    })

    const catalog = readStoreCatalog({
      marketplaces: [source('official', root)],
      overlays: [],
      installed: new Set([installKey('stripe', 'official')])
    })

    expect(catalog.entries.map((entry) => [entry.plugin.name, entry.installed])).toEqual([
      ['notion', false],
      ['stripe', true]
    ])
  })

  it('does not read an install from a different marketplace as this one', () => {
    // Two marketplaces can carry the same plugin name; installing one must not
    // make the other read as installed.
    const root = indexRoot({
      ours: marketplace('ours', [plugin('stripe')]),
      theirs: marketplace('theirs', [plugin('stripe')])
    })

    const catalog = readStoreCatalog({
      marketplaces: [source('ours', root), source('theirs', root)],
      overlays: [],
      installed: new Set([installKey('stripe', 'ours')])
    })

    expect(catalog.entries.map((entry) => [entry.marketplaceId, entry.installed])).toEqual([
      ['ours', true],
      ['theirs', false]
    ])
  })

  it('marks a plugin BuildEx curated, and leaves the long tail plainly uncurated', () => {
    const root = indexRoot({
      'buildex-packs': marketplace('buildex-packs', [plugin('stripe')]),
      'claude-plugins-official': marketplace('claude-plugins-official', [plugin('clickhouse')])
    })
    const overlays: StoreOverlay[] = [
      { pluginName: 'stripe', marketplaceId: 'buildex-packs', gate: { ask: ['mcp__stripe__pay'] } }
    ]

    const catalog = readStoreCatalog({
      marketplaces: [
        source('buildex-packs', root, 'business'),
        source('claude-plugins-official', root)
      ],
      overlays,
      installed: new Set()
    })

    expect(catalog.entries.map((entry) => [entry.plugin.name, entry.curated])).toEqual([
      ['stripe', true],
      ['clickhouse', false]
    ])
    expect(catalog.entries[0].overlay?.gate?.ask).toEqual(['mcp__stripe__pay'])
  })

  it('sorts what BuildEx vetted above the shelf nobody vetted', () => {
    // Why: opening on 276 unvetted plugins is not the shelf a company was sold.
    const root = indexRoot({
      official: marketplace('official', [plugin('aaa-first'), plugin('zzz-last')])
    })

    const catalog = readStoreCatalog({
      marketplaces: [source('official', root)],
      overlays: [{ pluginName: 'zzz-last' }],
      installed: new Set()
    })

    expect(catalog.entries.map((entry) => entry.plugin.name)).toEqual(['zzz-last', 'aaa-first'])
  })

  it('still lists a marketplace that has never been fetched, and fills the rest', () => {
    // A company marketplace that has never refreshed must not empty the shelf.
    const root = indexRoot({ present: marketplace('present', [plugin('acme')]) })

    const catalog = readStoreCatalog({
      marketplaces: [source('present', root), source('absent', root)],
      overlays: [],
      installed: new Set()
    })

    expect(catalog.entries.map((entry) => entry.plugin.name)).toEqual(['acme'])
    expect(catalog.marketplaces.map((entry) => entry.id)).toEqual(['present', 'absent'])
  })

  it('puts what the company expects above what BuildEx merely curated', () => {
    // Why: a teammate opening the Store after a clone should see this company's
    // apps first, not an alphabetical list of everything.
    const root = indexRoot({
      official: marketplace('official', [
        plugin('aaa-curated'),
        plugin('mmm-suggested'),
        plugin('zzz-required')
      ])
    })

    const catalog = readStoreCatalog({
      marketplaces: [source('official', root)],
      overlays: [{ pluginName: 'aaa-curated' }],
      installed: new Set(),
      roster: {
        path: 'apps.json',
        entries: [
          { pluginName: 'zzz-required', marketplaceId: 'official', requirement: 'required' },
          { pluginName: 'mmm-suggested', marketplaceId: 'official', requirement: 'suggested' }
        ]
      }
    })

    expect(catalog.entries.map((entry) => entry.plugin.name)).toEqual([
      'zzz-required',
      'mmm-suggested',
      'aaa-curated'
    ])
    expect(catalog.entries[0].requirement).toBe('required')
  })

  it('carries the reason the company gave, next to the app', () => {
    const root = indexRoot({ official: marketplace('official', [plugin('acme')]) })

    const catalog = readStoreCatalog({
      marketplaces: [source('official', root)],
      overlays: [],
      installed: new Set(),
      roster: {
        path: 'apps.json',
        entries: [
          {
            pluginName: 'acme',
            marketplaceId: 'official',
            requirement: 'required',
            reason: 'Support runs on it.'
          }
        ]
      }
    })

    expect(catalog.entries[0].requirementReason).toBe('Support runs on it.')
    expect(catalog.roster?.entries).toHaveLength(1)
  })

  it('does not expect an app the roster named in another marketplace', () => {
    const root = indexRoot({ ours: marketplace('ours', [plugin('stripe')]) })

    const catalog = readStoreCatalog({
      marketplaces: [source('ours', root)],
      overlays: [],
      installed: new Set(),
      roster: {
        path: 'apps.json',
        entries: [{ pluginName: 'stripe', marketplaceId: 'theirs', requirement: 'required' }]
      }
    })

    expect(catalog.entries[0].requirement).toBeUndefined()
  })

  it('carries the reason installing is unavailable rather than failing later', () => {
    const root = indexRoot({ official: marketplace('official', [plugin('acme')]) })

    const catalog = readStoreCatalog({
      marketplaces: [source('official', root)],
      overlays: [],
      installed: new Set(),
      unsupportedAgent: 'droid'
    })

    expect(catalog.unsupportedAgent).toBe('droid')
    expect(catalog.entries).toHaveLength(1)
  })

  it('does not leak the raw index body to the renderer', () => {
    const root = indexRoot({ official: marketplace('official', [plugin('acme')]) })

    const catalog = readStoreCatalog({
      marketplaces: [source('official', root)],
      overlays: [],
      installed: new Set()
    })

    expect(catalog.marketplaces[0]).not.toHaveProperty('indexBody')
  })
})

describe('KNOWN_MARKETPLACES', () => {
  it('keys each marketplace the way the agent keys it', () => {
    // Why: the id has to equal the `name` inside that marketplace.json, because
    // installs are recorded as `plugin@marketplace`. An invented id would never
    // match and every plugin would read as not-installed.
    expect(KNOWN_MARKETPLACES.map((entry) => entry.id)).toEqual([
      'claude-plugins-official',
      'buildex-packs',
      'protocol'
    ])
    expect(KNOWN_MARKETPLACES.find((entry) => entry.id === 'buildex-packs')?.defaultSegment).toBe(
      'business'
    )
  })
})
