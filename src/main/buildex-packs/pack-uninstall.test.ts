import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { embeddedLocation } from '../buildex-brain/brain-location'
import { listBrainSkills } from '../buildex-brain/brain-skills'
import { installPack } from './pack-install'
import { hashContent } from './pack-files'
import { readPackCatalog } from './pack-catalog'
import { uninstallPack } from './pack-uninstall'
import { readPackState } from './pack-state'

let repo = ''
let bundle = ''

function writeIn(root: string, relativePath: string, contents: string): void {
  const absolute = path.join(root, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

function seedPack(id = 'slack'): void {
  writeIn(
    bundle,
    `${id}/pack.json`,
    JSON.stringify({
      id,
      name: id.toUpperCase(),
      skills: [`${id}-search`],
      mcp: { kind: 'http', url: 'https://x.dev/mcp' }
    })
  )
  writeIn(bundle, `${id}/skills/${id}-search/SKILL.md`, '# search\n')
  writeIn(bundle, `${id}/skills/${id}-search/references/api.md`, '# api\n')
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-uninstall-repo-'))
  bundle = mkdtempSync(path.join(tmpdir(), 'buildex-uninstall-bundle-'))
  seedPack()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(bundle, { recursive: true, force: true })
})

describe('uninstallPack', () => {
  it('takes back exactly what it put in', () => {
    installPack(repo, 'slack', bundle)

    const result = uninstallPack(repo, 'slack', bundle)

    expect(result.ok).toBe(true)
    expect(result.removedPaths).toEqual([
      'skills/slack-search/SKILL.md',
      'skills/slack-search/references/api.md'
    ])
    expect(existsSync(path.join(repo, '.buildex/skills/slack-search'))).toBe(false)
    expect(readPackCatalog(repo, bundle).packs[0].installed).toBe(false)
  })

  it('removes the agent-facing link so the skill stops loading', () => {
    installPack(repo, 'slack', bundle)
    expect(existsSync(path.join(repo, '.claude/skills/slack-search'))).toBe(true)

    uninstallPack(repo, 'slack', bundle)

    expect(existsSync(path.join(repo, '.claude/skills/slack-search'))).toBe(false)
  })

  it('drops the MCP server from the file the agent reads', () => {
    installPack(repo, 'slack', bundle)

    uninstallPack(repo, 'slack', bundle)

    const config = JSON.parse(readFileSync(path.join(repo, '.mcp.json'), 'utf8'))
    expect(config.mcpServers.slack).toBeUndefined()
  })

  it('keeps a file the operator edited, and says so', () => {
    installPack(repo, 'slack', bundle)
    writeIn(repo, '.buildex/skills/slack-search/SKILL.md', '# tuned for us\n')

    const result = uninstallPack(repo, 'slack', bundle)

    expect(result.keptOperatorEdits).toEqual(['skills/slack-search/SKILL.md'])
    expect(readFileSync(path.join(repo, '.buildex/skills/slack-search/SKILL.md'), 'utf8')).toBe(
      '# tuned for us\n'
    )
    // The directory holding it must survive too.
    expect(existsSync(path.join(repo, '.buildex/skills/slack-search'))).toBe(true)
  })

  it('forgets the pack so a later refresh does not resurrect it', () => {
    installPack(repo, 'slack', bundle)

    uninstallPack(repo, 'slack', bundle)

    expect(readPackState(embeddedLocation(repo)).packs.slack).toBeUndefined()
  })

  it('still resolves, attributes, and uninstalls cleanly when a receipt predates brain-relative paths', () => {
    // Simulate a pack installed before packs moved to brain-root-relative receipts
    // — both the files on disk and the receipt itself used the old, repo-relative
    // `.buildex/skills/…` shape.
    writeIn(repo, '.buildex/skills/slack-search/SKILL.md', '# search\n')
    writeIn(repo, '.buildex/skills/slack-search/references/api.md', '# api\n')
    writeIn(
      repo,
      '.buildex/packs.json',
      JSON.stringify({
        packs: {
          slack: {
            files: {
              '.buildex/skills/slack-search/SKILL.md': hashContent('# search\n'),
              '.buildex/skills/slack-search/references/api.md': hashContent('# api\n')
            }
          }
        }
      })
    )

    // Still attributes to its pack, from the old-shape receipt.
    expect(
      listBrainSkills(repo, embeddedLocation(repo)).find((skill) => skill.name === 'slack-search')
        ?.source
    ).toBe('pack')

    const result = uninstallPack(repo, 'slack', bundle)

    // Still resolves and still uninstalls cleanly.
    expect(result.ok).toBe(true)
    expect(result.removedPaths).toEqual([
      '.buildex/skills/slack-search/SKILL.md',
      '.buildex/skills/slack-search/references/api.md'
    ])
    expect(existsSync(path.join(repo, '.buildex/skills/slack-search'))).toBe(false)
    expect(readPackState(embeddedLocation(repo)).packs.slack).toBeUndefined()
  })

  it('reports a pack that was never installed', () => {
    const result = uninstallPack(repo, 'slack', bundle)

    expect(result).toMatchObject({ ok: false, removedPaths: [] })
    expect(result.error).toContain('slack')
  })

  it('leaves another pack alone', () => {
    seedPack('stripe')
    installPack(repo, 'slack', bundle)
    installPack(repo, 'stripe', bundle)

    uninstallPack(repo, 'slack', bundle)

    expect(existsSync(path.join(repo, '.buildex/skills/stripe-search/SKILL.md'))).toBe(true)
    expect(readPackState(embeddedLocation(repo)).packs.stripe).toBeDefined()
  })
})
