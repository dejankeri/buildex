import { describe, expect, it } from 'vitest'
import type {
  StoreCatalog,
  StoreEntry,
  StoreRequirement
} from '../../../../shared/buildex-store-types'
import { EMPTY_STORE_CATALOG } from '../../../../shared/buildex-store-types'
import { resolveRosterStatus } from './store-roster-status'

function entry(name: string, installed: boolean, requirement?: StoreRequirement): StoreEntry {
  return {
    plugin: {
      name,
      displayName: name,
      description: '',
      category: null,
      author: null,
      homepage: null,
      keywords: [],
      source: { kind: 'marketplace-relative', path: `./plugins/${name}` }
    },
    marketplaceId: 'buildex',
    marketplaceLabel: 'BuildEx',
    segment: 'business',
    curated: true,
    overlay: { pluginName: name },
    installed,
    requirement
  }
}

function catalog(entries: StoreEntry[], rostered: [string, StoreRequirement][]): StoreCatalog {
  return {
    ...EMPTY_STORE_CATALOG,
    entries,
    roster: {
      path: '.buildex/apps.json',
      entries: rostered.map(([pluginName, requirement]) => ({
        pluginName,
        marketplaceId: 'buildex',
        requirement
      }))
    }
  }
}

describe('resolveRosterStatus', () => {
  it('is nothing to show when the repo has no brain or an empty roster', () => {
    expect(resolveRosterStatus(EMPTY_STORE_CATALOG)).toBeNull()
    expect(resolveRosterStatus(catalog([], []))).toBeNull()
  })

  it('counts what the company expects and what this machine is missing', () => {
    const status = resolveRosterStatus(
      catalog(
        [
          entry('stripe', false, 'required'),
          entry('notion', true, 'required'),
          entry('canva', false, 'suggested'),
          entry('playwright', false)
        ],
        [
          ['stripe', 'required'],
          ['notion', 'required'],
          ['canva', 'suggested']
        ]
      )
    )
    expect(status).not.toBeNull()
    expect(status?.expected).toBe(3)
    expect(status?.requiredCount).toBe(2)
    expect(status?.suggestedCount).toBe(1)
    expect(status?.missing.map((match) => match.plugin.name)).toEqual(['stripe', 'canva'])
    expect(status?.path).toBe('.buildex/apps.json')
  })

  it('keeps the catalog order, which already puts required first', () => {
    const status = resolveRosterStatus(
      catalog(
        [entry('required-app', false, 'required'), entry('suggested-app', false, 'suggested')],
        [
          ['suggested-app', 'suggested'],
          ['required-app', 'required']
        ]
      )
    )
    expect(status?.missing.map((match) => match.plugin.name)).toEqual([
      'required-app',
      'suggested-app'
    ])
  })

  it('reports a rostered app no marketplace carries any more', () => {
    const status = resolveRosterStatus(
      catalog(
        [entry('stripe', true, 'required')],
        [
          ['stripe', 'required'],
          ['retired-app', 'suggested']
        ]
      )
    )
    expect(status?.unavailable.map((line) => line.pluginName)).toEqual(['retired-app'])
    expect(status?.missing).toEqual([])
  })
})
