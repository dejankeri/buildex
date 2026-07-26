import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPackCatalog } from './pack-catalog'
import { installPack } from './pack-install'
import { parsePackManifest } from './pack-manifest'

let repo = ''

function write(relativePath: string, contents: string): void {
  const absolute = path.join(repo, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

function writePack(root: string, id: string, extra: Record<string, unknown> = {}): void {
  write(
    `${root}/${id}/pack.json`,
    JSON.stringify({ id, name: id.toUpperCase(), skills: [`${id}-search`], ...extra })
  )
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-packs-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('parsePackManifest', () => {
  it('rejects manifests with a missing or malformed id', () => {
    expect(parsePackManifest('{"name":"X"}', 'p')).toBeNull()
    expect(parsePackManifest('{"id":"../escape","name":"X"}', 'p')).toBeNull()
    expect(parsePackManifest('not json', 'p')).toBeNull()
  })

  it('drops skill names that could escape the skills directory', () => {
    const pack = parsePackManifest(
      '{"id":"a","name":"A","skills":["ok-skill","../../etc/passwd","Bad Name"]}',
      'p'
    )
    expect(pack?.skills).toEqual(['ok-skill'])
  })

  it('ignores non-http app urls', () => {
    const pack = parsePackManifest('{"id":"a","name":"A","app":{"url":"file:///etc/passwd"}}', 'p')
    expect(pack?.app).toBeUndefined()
  })

  it('keeps http app urls and mcp faces', () => {
    const pack = parsePackManifest(
      '{"id":"a","name":"A","app":{"url":"https://x.dev"},"mcp":{"kind":"http","url":"https://x.dev/mcp"}}',
      'p'
    )
    expect(pack?.app).toEqual({ url: 'https://x.dev' })
    expect(pack?.mcp).toEqual({ kind: 'http', url: 'https://x.dev/mcp' })
  })
})

describe('readPackCatalog', () => {
  it('returns nothing when the repo has no catalog', () => {
    expect(readPackCatalog(repo).packs).toEqual([])
  })

  it('reads packs and sorts them by name', () => {
    writePack('catalog', 'zed')
    writePack('catalog', 'acme')

    const catalog = readPackCatalog(repo)

    expect(catalog.packs.map((p) => p.id)).toEqual(['acme', 'zed'])
    expect(catalog.catalogRoots).toEqual(['catalog'])
  })

  it("lets a company's own catalog override a vendored core copy", () => {
    writePack('packs/core/catalog', 'linear', { name: 'Vendored' })
    writePack('catalog', 'linear', { name: 'Company' })

    expect(readPackCatalog(repo).packs.find((p) => p.id === 'linear')?.name).toBe('Company')
  })

  it('marks a pack installed only when every declared skill exists', () => {
    writePack('catalog', 'linear', { skills: ['linear-search', 'linear-issue'] })
    write('skills/linear-search/SKILL.md', '# one')

    expect(readPackCatalog(repo).packs[0]?.installed).toBe(false)

    write('skills/linear-issue/SKILL.md', '# two')
    expect(readPackCatalog(repo).packs[0]?.installed).toBe(true)
  })

  it('skips malformed manifests without failing the whole catalog', () => {
    write('catalog/broken/pack.json', '{ not json')
    writePack('catalog', 'good')

    expect(readPackCatalog(repo).packs.map((p) => p.id)).toEqual(['good'])
  })
})

describe('installPack', () => {
  it('writes a scaffold for every declared skill', () => {
    writePack('catalog', 'linear', { skills: ['linear-search', 'linear-issue'] })

    const result = installPack(repo, 'linear')

    expect(result.ok).toBe(true)
    expect(result.writtenPaths).toEqual([
      'skills/linear-issue/SKILL.md',
      'skills/linear-search/SKILL.md'
    ])
    expect(existsSync(path.join(repo, 'skills/linear-search/SKILL.md'))).toBe(true)
    expect(readPackCatalog(repo).packs[0]?.installed).toBe(true)
  })

  it('never overwrites a skill the operator already edited', () => {
    writePack('catalog', 'linear', { skills: ['linear-search'] })
    write('skills/linear-search/SKILL.md', '# my own words')

    const result = installPack(repo, 'linear')

    expect(result.writtenPaths).toEqual([])
    expect(
      readPackCatalog(repo).packs[0]?.installed,
      'already-present skills still count as installed'
    ).toBe(true)
  })

  it('reports an unknown pack instead of writing anything', () => {
    const result = installPack(repo, 'nope')

    expect(result).toMatchObject({ ok: false, writtenPaths: [] })
    expect(result.error).toContain('nope')
  })
})
