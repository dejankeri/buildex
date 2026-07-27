import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPackCatalog } from './pack-catalog'
import { installPack } from './pack-install'
import { refreshInstalledPacks } from './pack-refresh'

// The shipped catalog is the update channel: a new BuildEx carries newer skills,
// and an operator who installed a pack months ago gets them without reinstalling.

let repo = ''
let bundle = ''

function writeIn(root: string, relativePath: string, contents: string): void {
  const absolute = path.join(root, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

function writeBundledPack(
  id: string,
  skillBody: string,
  extra: Record<string, unknown> = {}
): void {
  writeIn(
    bundle,
    `${id}/pack.json`,
    JSON.stringify({ id, name: id.toUpperCase(), skills: [`${id}-search`], ...extra })
  )
  writeIn(bundle, `${id}/skills/${id}-search/SKILL.md`, skillBody)
}

function readRepo(relativePath: string): string {
  return readFileSync(path.join(repo, relativePath), 'utf8')
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-refresh-repo-'))
  bundle = mkdtempSync(path.join(tmpdir(), 'buildex-refresh-bundle-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(bundle, { recursive: true, force: true })
})

describe('bundled catalog', () => {
  it('fills the Store for a repo that has no catalog of its own', () => {
    writeBundledPack('slack', '# v1')

    const catalog = readPackCatalog(repo, bundle)

    expect(catalog.packs.map((pack) => pack.id)).toEqual(['slack'])
    expect(catalog.packs[0].source).toBe('bundle')
    expect(catalog.catalogRoots).toEqual(['bundle'])
  })

  it("lets a company's own catalog shadow a bundled pack of the same id", () => {
    writeBundledPack('slack', '# shipped')
    writeIn(repo, 'catalog/slack/pack.json', JSON.stringify({ id: 'slack', name: 'Our Slack' }))

    const pack = readPackCatalog(repo, bundle).packs.find((candidate) => candidate.id === 'slack')

    expect(pack?.name).toBe('Our Slack')
    expect(pack?.source).toBe('repo')
  })

  it('ignores a bundled root that is not there', () => {
    expect(readPackCatalog(repo, path.join(bundle, 'missing')).packs).toEqual([])
  })
})

describe('refreshInstalledPacks', () => {
  it('does nothing when no pack is installed', () => {
    writeBundledPack('slack', '# v1')

    expect(refreshInstalledPacks(repo, bundle)).toEqual({
      updatedPackIds: [],
      writtenPaths: [],
      keptOperatorEdits: []
    })
  })

  it('brings an installed pack up to the version the app now ships', () => {
    writeBundledPack('slack', '# v1')
    installPack(repo, 'slack', bundle)

    writeBundledPack('slack', '# v2 - better steps')
    const result = refreshInstalledPacks(repo, bundle)

    expect(result.updatedPackIds).toEqual(['slack'])
    expect(readRepo('skills/slack-search/SKILL.md')).toBe('# v2 - better steps')
  })

  it('adds a file a newer pack version introduces', () => {
    writeBundledPack('slack', '# v1')
    installPack(repo, 'slack', bundle)

    writeIn(bundle, 'slack/skills/slack-search/references/limits.md', '# rate limits')
    const result = refreshInstalledPacks(repo, bundle)

    expect(result.writtenPaths).toContain('skills/slack-search/references/limits.md')
  })

  it("keeps the operator's edits and reports them instead of overwriting", () => {
    writeBundledPack('slack', '# v1')
    installPack(repo, 'slack', bundle)
    writeIn(repo, 'skills/slack-search/SKILL.md', '# tuned for us')

    writeBundledPack('slack', '# v2')
    const result = refreshInstalledPacks(repo, bundle)

    expect(result.updatedPackIds).toEqual([])
    expect(result.keptOperatorEdits).toEqual(['skills/slack-search/SKILL.md'])
    expect(readRepo('skills/slack-search/SKILL.md')).toBe('# tuned for us')
  })

  it('never installs a pack the company did not ask for', () => {
    writeBundledPack('slack', '# v1')
    installPack(repo, 'slack', bundle)
    writeBundledPack('stripe', '# stripe v1')

    refreshInstalledPacks(repo, bundle)

    expect(readPackCatalog(repo, bundle).packs.find((p) => p.id === 'stripe')?.installed).toBe(
      false
    )
  })

  it('leaves a pack alone when it vanishes from the catalog', () => {
    writeBundledPack('slack', '# v1')
    installPack(repo, 'slack', bundle)
    rmSync(path.join(bundle, 'slack'), { recursive: true, force: true })

    const result = refreshInstalledPacks(repo, bundle)

    expect(result.updatedPackIds).toEqual([])
    expect(readRepo('skills/slack-search/SKILL.md')).toBe('# v1')
  })

  it('is idempotent — a second refresh writes nothing', () => {
    writeBundledPack('slack', '# v1')
    installPack(repo, 'slack', bundle)
    writeBundledPack('slack', '# v2')

    refreshInstalledPacks(repo, bundle)
    const second = refreshInstalledPacks(repo, bundle)

    expect(second.writtenPaths).toEqual([])
    expect(second.updatedPackIds).toEqual([])
  })
})
