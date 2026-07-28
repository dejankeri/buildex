import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { embeddedLocation, externalLocation } from '../buildex-brain/brain-location'
import type * as BrainLocationModule from '../buildex-brain/brain-location'

// Why: resolution reads a bindings file under the app's user data path, which a
// test has no Electron to give it. This is the one seam that lets an external
// brain be exercised end to end.
const resolved = vi.hoisted(() => ({ location: null as null | { root: string } }))
vi.mock('../buildex-brain/brain-location', async () => {
  const actual = await vi.importActual<typeof BrainLocationModule>(
    '../buildex-brain/brain-location'
  )
  return { ...actual, requireBrainLocation: () => resolved.location }
})
import { listBrainSkills } from '../buildex-brain/brain-skills'
import { installPack } from './pack-install'
import { hashContent } from './pack-files'
import { readPackCatalog } from './pack-catalog'
import { refreshInstalledPacks } from './pack-refresh'
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

  it('migrates an old-shape receipt on refresh, so a later uninstall reports it cleanly', () => {
    // Old-shape receipt, as if this pack was installed before receipts moved to
    // the brain-relative shape — refresh must migrate it, not leave a stale row
    // beside the new one, or uninstall later reads the stale row as an edit.
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

    // The bundle now ships a newer version of the skill.
    writeIn(bundle, 'slack/skills/slack-search/SKILL.md', '# search v2\n')

    const refreshed = refreshInstalledPacks(repo, bundle)
    expect(refreshed.updatedPackIds).toEqual(['slack'])
    expect(refreshed.keptOperatorEdits).toEqual([])

    // Exactly one key per file — the pre-migration row did not survive alongside it.
    expect(Object.keys(readPackState(embeddedLocation(repo)).packs.slack.files).sort()).toEqual([
      'skills/slack-search/SKILL.md',
      'skills/slack-search/references/api.md'
    ])

    const result = uninstallPack(repo, 'slack', bundle)

    expect(result.ok).toBe(true)
    expect(result.keptOperatorEdits).toEqual([])
    expect(result.removedPaths.sort()).toEqual([
      'skills/slack-search/SKILL.md',
      'skills/slack-search/references/api.md'
    ])
  })

  it('uninstalls from the shared brain when the receipt still names the old repo path', () => {
    // A pack installed before this branch, then migrated: refresh only rewrites
    // a receipt when something is written or kept, so an unchanged catalog
    // leaves the legacy `.buildex/`-prefixed key exactly where it was.
    const brain = mkdtempSync(path.join(tmpdir(), 'buildex-uninstall-brain-'))
    resolved.location = externalLocation(brain)
    try {
      writeIn(brain, 'skills/slack-search/SKILL.md', '# search\n')
      writeIn(brain, 'skills/slack-search/references/api.md', '# api\n')
      writeIn(
        brain,
        'packs.json',
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

      const result = uninstallPack(repo, 'slack', bundle)

      // Was: ok with an empty removedPaths, the files still in the shared brain,
      // the pack still reporting installed, and a second uninstall erroring.
      expect(result.ok).toBe(true)
      expect(result.removedPaths).toEqual([
        '.buildex/skills/slack-search/SKILL.md',
        '.buildex/skills/slack-search/references/api.md'
      ])
      expect(existsSync(path.join(brain, 'skills', 'slack-search'))).toBe(false)
    } finally {
      resolved.location = null
      rmSync(brain, { recursive: true, force: true })
    }
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
