import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrainLocation } from '../../shared/buildex-brain-types'
import {
  parseStoreRoster,
  readStoreRoster,
  rosterIndex,
  ROSTER_FILE_NAME,
  setRosterEntry
} from './store-roster'

const roots: string[] = []

function brain(mode: BrainLocation['mode'] = 'embedded', body?: string): BrainLocation {
  const created = mkdtempSync(path.join(tmpdir(), 'buildex-brain-'))
  roots.push(created)
  if (body !== undefined) {
    writeFileSync(path.join(created, ROSTER_FILE_NAME), body, 'utf8')
  }
  return { root: created, gitRoot: created, mode, pathspec: '.' }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('parseStoreRoster', () => {
  it('reads what the company expects installed', () => {
    const roster = parseStoreRoster(
      JSON.stringify({
        apps: [
          {
            pluginName: 'protocol-crm',
            marketplaceId: 'protocol',
            requirement: 'required',
            reason: 'Every client lives here.'
          },
          { pluginName: 'stripe', marketplaceId: 'buildex-packs', requirement: 'suggested' }
        ]
      }),
      '.buildex/apps.json'
    )

    expect(roster.entries).toEqual([
      {
        pluginName: 'protocol-crm',
        marketplaceId: 'protocol',
        requirement: 'required',
        reason: 'Every client lives here.'
      },
      { pluginName: 'stripe', marketplaceId: 'buildex-packs', requirement: 'suggested' }
    ])
  })

  it('accepts the shorter spelling a person would hand-write', () => {
    // The file is meant to be edited and reviewed by people, not only written
    // by the Store.
    const roster = parseStoreRoster(
      JSON.stringify([{ plugin: 'stripe', marketplace: 'buildex-packs', requirement: 'required' }]),
      'apps.json'
    )

    expect(roster.entries[0]).toMatchObject({ pluginName: 'stripe', requirement: 'required' })
  })

  it('skips a row that names no requirement rather than guessing one', () => {
    const roster = parseStoreRoster(
      JSON.stringify({
        apps: [
          { pluginName: 'a', marketplaceId: 'm', requirement: 'mandatory' },
          { pluginName: 'b', marketplaceId: 'm' },
          { pluginName: 'c', marketplaceId: 'm', requirement: 'required' }
        ]
      }),
      'apps.json'
    )

    expect(roster.entries.map((entry) => entry.pluginName)).toEqual(['c'])
  })

  it('reads a hand-broken file as nothing expected, not as a failure', () => {
    // Why: a typo in a shared file must not empty the Store for the whole team.
    expect(parseStoreRoster('{ not json', 'apps.json').entries).toEqual([])
  })
})

describe('setRosterEntry', () => {
  it('adds an app and writes a file a teammate can commit', () => {
    const location = brain()

    const roster = setRosterEntry(location, {
      pluginName: 'protocol-crm',
      marketplaceId: 'protocol',
      requirement: 'required',
      reason: 'Every client lives here.'
    })

    expect(roster.entries).toHaveLength(1)
    const written = JSON.parse(readFileSync(path.join(location.root, ROSTER_FILE_NAME), 'utf8'))
    expect(written.apps[0]).toMatchObject({
      pluginName: 'protocol-crm',
      requirement: 'required',
      reason: 'Every client lives here.'
    })
  })

  it('changes an app’s requirement without duplicating it', () => {
    const location = brain()
    setRosterEntry(location, {
      pluginName: 'stripe',
      marketplaceId: 'buildex-packs',
      requirement: 'suggested'
    })

    const roster = setRosterEntry(location, {
      pluginName: 'stripe',
      marketplaceId: 'buildex-packs',
      requirement: 'required'
    })

    expect(roster.entries).toEqual([
      { pluginName: 'stripe', marketplaceId: 'buildex-packs', requirement: 'required' }
    ])
  })

  it('keeps the same app from two marketplaces apart', () => {
    // Our stripe and upstream's stripe are different products; a company can
    // expect one and not the other.
    const location = brain()
    setRosterEntry(location, {
      pluginName: 'stripe',
      marketplaceId: 'buildex-packs',
      requirement: 'required'
    })

    const roster = setRosterEntry(location, {
      pluginName: 'stripe',
      marketplaceId: 'claude-plugins-official',
      requirement: 'suggested'
    })

    expect(roster.entries).toHaveLength(2)
  })

  it('sorts the file so two people do not fight over the diff', () => {
    const location = brain()
    setRosterEntry(location, { pluginName: 'zeta', marketplaceId: 'm', requirement: 'required' })
    setRosterEntry(location, { pluginName: 'alpha', marketplaceId: 'm', requirement: 'required' })

    const written = JSON.parse(readFileSync(path.join(location.root, ROSTER_FILE_NAME), 'utf8'))
    expect(written.apps.map((app: { pluginName: string }) => app.pluginName)).toEqual([
      'alpha',
      'zeta'
    ])
  })

  it('removes the file entirely when the last app comes off the roster', () => {
    // An empty roster left behind would show a teammate a file that says nothing.
    const location = brain()
    setRosterEntry(location, { pluginName: 'solo', marketplaceId: 'm', requirement: 'required' })

    const roster = setRosterEntry(location, {
      pluginName: 'solo',
      marketplaceId: 'm',
      requirement: null
    })

    expect(roster.entries).toEqual([])
    expect(existsSync(path.join(location.root, ROSTER_FILE_NAME))).toBe(false)
  })
})

describe('readStoreRoster', () => {
  it('reads what a teammate committed', () => {
    const location = brain(
      'embedded',
      JSON.stringify({
        apps: [{ pluginName: 'protocol-crm', marketplaceId: 'protocol', requirement: 'required' }]
      })
    )

    expect(readStoreRoster(location).entries).toHaveLength(1)
  })

  it('is empty for a brain that has never named an app', () => {
    expect(readStoreRoster(brain()).entries).toEqual([])
  })

  it('names the file relative to the repo for an embedded brain', () => {
    const embedded = brain()
    expect(readStoreRoster(embedded).path).toContain(ROSTER_FILE_NAME)
  })
})

describe('rosterIndex', () => {
  it('keys by plugin and marketplace together', () => {
    const index = rosterIndex({
      path: 'apps.json',
      entries: [{ pluginName: 'stripe', marketplaceId: 'buildex-packs', requirement: 'required' }]
    })

    expect(index.get('stripe@buildex-packs')?.requirement).toBe('required')
    expect(index.get('stripe@claude-plugins-official')).toBeUndefined()
  })

  it('is empty when the repo has no brain to read a roster from', () => {
    expect(rosterIndex(null).size).toBe(0)
  })
})
