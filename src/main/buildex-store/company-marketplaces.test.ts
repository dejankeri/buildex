import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrainLocation } from '../../shared/buildex-brain-types'
import {
  addCompanyMarketplace,
  companyMarketplaceProblem,
  COMPANY_MARKETPLACES_FILE_NAME,
  marketplaceIdProblem,
  marketplaceSourceProblem,
  parseCompanyMarketplaces,
  readCompanyMarketplaces,
  removeCompanyMarketplace
} from './company-marketplaces'

const roots: string[] = []

function brain(mode: BrainLocation['mode'] = 'embedded', body?: string): BrainLocation {
  const created = mkdtempSync(path.join(tmpdir(), 'buildex-brain-'))
  roots.push(created)
  if (body !== undefined) {
    writeFileSync(path.join(created, COMPANY_MARKETPLACES_FILE_NAME), body, 'utf8')
  }
  return { root: created, gitRoot: created, mode, pathspec: '.' }
}

function read(location: BrainLocation): { marketplaces: { id: string; repo: string }[] } {
  return JSON.parse(
    readFileSync(path.join(location.root, COMPANY_MARKETPLACES_FILE_NAME), 'utf8')
  ) as { marketplaces: { id: string; repo: string }[] }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('marketplaceSourceProblem', () => {
  const ok = { label: 'Acme', repo: 'acme/plugins' }

  it('accepts an owner/repo slug', () => {
    expect(marketplaceSourceProblem(ok)).toBeNull()
  })

  it('accepts an https URL to a marketplace.json a company hosts', () => {
    expect(
      marketplaceSourceProblem({ ...ok, repo: 'https://acme.dev/marketplace.json' })
    ).toBeNull()
  })

  it('refuses plain http, which a teammate would inherit by pulling', () => {
    expect(
      marketplaceSourceProblem({ ...ok, repo: 'http://acme.dev/marketplace.json' })
    ).not.toBeNull()
  })

  it('refuses a marketplace with no name for the team to recognise', () => {
    expect(marketplaceSourceProblem({ ...ok, label: '  ' })).not.toBeNull()
  })
})

describe('marketplaceIdProblem', () => {
  it('accepts the name a marketplace declares', () => {
    expect(marketplaceIdProblem('acme-internal', ['protocol'])).toBeNull()
  })

  it('refuses an id a bundled marketplace already uses', () => {
    // Why: the id is the key the agent records installs under, so a collision
    // would make both marketplaces read as the same installed plugin.
    expect(marketplaceIdProblem('protocol', ['protocol'])).toContain('protocol')
  })

  it('refuses a collision that differs only in case', () => {
    expect(marketplaceIdProblem('Protocol', ['protocol'])).not.toBeNull()
  })

  it('refuses an id that would not survive being a cache filename', () => {
    expect(marketplaceIdProblem('../escape', [])).not.toBeNull()
  })

  it('refuses a manifest that declares no name at all', () => {
    expect(marketplaceIdProblem('  ', [])).not.toBeNull()
  })
})

describe('companyMarketplaceProblem', () => {
  it('reports the id problem and the source problem through one call', () => {
    expect(
      companyMarketplaceProblem({ id: 'acme', label: 'Acme', repo: 'acme/plugins' }, [])
    ).toBeNull()
    expect(
      companyMarketplaceProblem({ id: 'acme', label: '', repo: 'acme/plugins' }, [])
    ).not.toBeNull()
    expect(
      companyMarketplaceProblem({ id: 'acme', label: 'Acme', repo: 'acme/plugins' }, ['acme'])
    ).not.toBeNull()
  })
})

describe('parseCompanyMarketplaces', () => {
  it('reads what a teammate committed', () => {
    const list = parseCompanyMarketplaces(
      JSON.stringify({
        marketplaces: [
          {
            id: 'acme-internal',
            label: 'Acme internal',
            repo: 'acme/plugins',
            defaultSegment: 'software'
          }
        ]
      }),
      '.buildex/marketplaces.json'
    )

    expect(list.entries).toEqual([
      {
        id: 'acme-internal',
        label: 'Acme internal',
        repo: 'acme/plugins',
        defaultSegment: 'software'
      }
    ])
  })

  it('falls back to the id when a hand-written entry names no label', () => {
    const list = parseCompanyMarketplaces(
      JSON.stringify([{ id: 'acme', repo: 'acme/plugins' }]),
      'marketplaces.json'
    )

    expect(list.entries[0]).toMatchObject({ id: 'acme', label: 'acme', defaultSegment: 'business' })
  })

  it('skips a row with no repo rather than showing an unfetchable marketplace', () => {
    const list = parseCompanyMarketplaces(
      JSON.stringify({ marketplaces: [{ id: 'a' }, { id: 'b', repo: 'b/plugins' }] }),
      'marketplaces.json'
    )

    expect(list.entries.map((entry) => entry.id)).toEqual(['b'])
  })

  it('reads a hand-broken file as no marketplaces, not as a failure', () => {
    // A typo in a shared file must not empty the Store for the whole team.
    expect(parseCompanyMarketplaces('{ not json', 'marketplaces.json').entries).toEqual([])
  })
})

describe('addCompanyMarketplace', () => {
  it('writes a file a teammate can commit', () => {
    const location = brain()

    const list = addCompanyMarketplace(location, {
      id: 'acme-internal',
      label: 'Acme internal',
      repo: 'acme/plugins',
      defaultSegment: 'software'
    })

    expect(list.entries).toHaveLength(1)
    expect(read(location).marketplaces[0]).toMatchObject({
      id: 'acme-internal',
      repo: 'acme/plugins'
    })
  })

  it('replaces the entry under an id rather than duplicating it', () => {
    // Re-adding under the same id is how a mistyped repo gets corrected.
    const location = brain()
    addCompanyMarketplace(location, {
      id: 'acme',
      label: 'Acme',
      repo: 'acme/wrong',
      defaultSegment: 'business'
    })

    const list = addCompanyMarketplace(location, {
      id: 'acme',
      label: 'Acme',
      repo: 'acme/plugins',
      defaultSegment: 'business'
    })

    expect(list.entries).toEqual([
      { id: 'acme', label: 'Acme', repo: 'acme/plugins', defaultSegment: 'business' }
    ])
  })

  it('sorts the file so two people do not fight over the diff', () => {
    const location = brain()
    addCompanyMarketplace(location, {
      id: 'zeta',
      label: 'Zeta',
      repo: 'z/plugins',
      defaultSegment: 'business'
    })
    addCompanyMarketplace(location, {
      id: 'alpha',
      label: 'Alpha',
      repo: 'a/plugins',
      defaultSegment: 'business'
    })

    expect(read(location).marketplaces.map((entry) => entry.id)).toEqual(['alpha', 'zeta'])
  })
})

describe('removeCompanyMarketplace', () => {
  it('takes one off and leaves the rest', () => {
    const location = brain()
    addCompanyMarketplace(location, {
      id: 'acme',
      label: 'Acme',
      repo: 'acme/plugins',
      defaultSegment: 'business'
    })
    addCompanyMarketplace(location, {
      id: 'partner',
      label: 'Partner',
      repo: 'partner/plugins',
      defaultSegment: 'business'
    })

    const list = removeCompanyMarketplace(location, 'acme')

    expect(list.entries.map((entry) => entry.id)).toEqual(['partner'])
  })

  it('removes the file entirely when the last marketplace comes off', () => {
    const location = brain()
    addCompanyMarketplace(location, {
      id: 'solo',
      label: 'Solo',
      repo: 'solo/plugins',
      defaultSegment: 'business'
    })

    const list = removeCompanyMarketplace(location, 'solo')

    expect(list.entries).toEqual([])
    expect(existsSync(path.join(location.root, COMPANY_MARKETPLACES_FILE_NAME))).toBe(false)
  })

  it('is not an error for a marketplace that was never there', () => {
    expect(removeCompanyMarketplace(brain(), 'ghost').entries).toEqual([])
  })
})

describe('readCompanyMarketplaces', () => {
  it('is empty for a brain that has never added one', () => {
    expect(readCompanyMarketplaces(brain()).entries).toEqual([])
  })

  it('names the file relative to the repo for an embedded brain', () => {
    expect(readCompanyMarketplaces(brain()).path).toContain(COMPANY_MARKETPLACES_FILE_NAME)
  })
})
