import { describe, expect, it } from 'vitest'
import { parseMarketplaceManifest } from './marketplace-manifest'

function manifest(plugins: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'official', owner: { name: 'Anthropic' }, ...extra, plugins })
}

describe('parseMarketplaceManifest', () => {
  it('reads the four source spellings upstream actually uses', () => {
    const parsed = parseMarketplaceManifest(
      manifest([
        {
          name: 'stripe',
          description: 'Stripe development plugin for Claude',
          category: 'development',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/stripe/ai.git',
            path: 'providers/claude/plugin',
            ref: 'main',
            sha: '84c364c'
          }
        },
        {
          name: 'agentforce-adlc',
          description: 'Agentforce',
          source: {
            source: 'url',
            url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
            sha: '74e7c25'
          }
        },
        {
          name: 'fullstory',
          description: 'Fullstory',
          source: { source: 'github', repo: 'fullstorydev/fullstory-skills', sha: 'b20614e' }
        },
        {
          name: 'agent-sdk-dev',
          description: 'Agent SDK',
          source: './plugins/agent-sdk-dev'
        }
      ])
    )

    expect(parsed?.plugins.map((plugin) => plugin.source)).toEqual([
      {
        url: 'https://github.com/stripe/ai.git',
        path: 'providers/claude/plugin',
        // The sha outranks the ref: an entry carrying both is pinned to the sha.
        pin: '84c364c'
      },
      { url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git', pin: '74e7c25' },
      { url: 'https://github.com/fullstorydev/fullstory-skills.git', pin: 'b20614e' },
      { url: null, path: 'plugins/agent-sdk-dev' }
    ])
  })

  it('falls back to the name when a listing carries no displayName', () => {
    const parsed = parseMarketplaceManifest(
      manifest([
        { name: 'canva', displayName: 'Canva', description: 'Design', source: './plugins/canva' },
        { name: 'notion', description: 'Docs', source: './plugins/notion' }
      ])
    )

    expect(parsed?.plugins.map((plugin) => plugin.displayName)).toEqual(['Canva', 'notion'])
  })

  it('reads the owner and keywords a card shows, and tolerates their absence', () => {
    const parsed = parseMarketplaceManifest(
      manifest([
        {
          name: 'canva',
          description: 'Design',
          author: { name: 'Canva' },
          homepage: 'https://www.canva.com/developers/',
          keywords: ['design', 'design', 42, 'poster'],
          source: './plugins/canva'
        }
      ])
    )

    expect(parsed?.owner).toBe('Anthropic')
    expect(parsed?.plugins[0]).toMatchObject({
      author: 'Canva',
      homepage: 'https://www.canva.com/developers/',
      // Deduplicated, non-strings dropped, so a hostile index cannot pad a card.
      keywords: ['design', 'poster']
    })
  })

  it('skips a malformed entry instead of failing the whole marketplace', () => {
    // Why: one bad row in a 276-entry index must not empty the Store.
    const parsed = parseMarketplaceManifest(
      manifest([
        { name: 'good', description: 'ok', source: './plugins/good' },
        { name: 'Bad Name', description: 'bad id', source: './plugins/bad' },
        { description: 'no name', source: './plugins/nameless' },
        { name: 'no-source', description: 'nothing to install from' },
        'not-an-object',
        { name: 'also-good', description: 'ok', source: './plugins/also-good' }
      ])
    )

    expect(parsed?.plugins.map((plugin) => plugin.name)).toEqual(['good', 'also-good'])
  })

  it('refuses a git source that is not http(s)', () => {
    // Why: this URL is the one field of a source that this process acts on — the
    // provenance line offers to open it — so a manifest must not be able to
    // smuggle file:// or a custom scheme into `shell.openUrl`. The rest of a
    // source is only ever resolved by the agent's CLI, out of a clone it made
    // itself, and is deliberately not validated.
    const parsed = parseMarketplaceManifest(
      manifest([
        { name: 'local', description: 'x', source: { source: 'url', url: 'file:///etc' } },
        { name: 'ssh', description: 'x', source: { source: 'url', url: 'git@github.com:a/b.git' } },
        {
          name: 'fine',
          description: 'x',
          source: { source: 'url', url: 'https://github.com/a/b.git' }
        }
      ])
    )

    expect(parsed?.plugins.map((plugin) => plugin.name)).toEqual(['fine'])
  })

  it('drops a homepage that is not http(s) but keeps the plugin', () => {
    const parsed = parseMarketplaceManifest(
      manifest([
        {
          name: 'odd',
          description: 'x',
          homepage: 'javascript:alert(1)',
          source: './plugins/odd'
        }
      ])
    )

    expect(parsed?.plugins[0]).toMatchObject({ name: 'odd', homepage: null })
  })

  it('keeps the last entry when a marketplace lists a name twice', () => {
    // Upstream pins by sha and re-lists on update; two rows for one name means
    // the later one is current.
    const parsed = parseMarketplaceManifest(
      manifest([
        { name: 'dup', description: 'old', source: './plugins/dup-old' },
        { name: 'dup', description: 'new', source: './plugins/dup-new' }
      ])
    )

    expect(parsed?.plugins).toHaveLength(1)
    expect(parsed?.plugins[0].description).toBe('new')
  })

  it('returns null for a body that is not a marketplace at all', () => {
    expect(parseMarketplaceManifest('not json')).toBeNull()
    expect(parseMarketplaceManifest('[]')).toBeNull()
    expect(parseMarketplaceManifest(JSON.stringify({ plugins: [] }))).toBeNull()
    expect(parseMarketplaceManifest(JSON.stringify({ name: 'x' }))).toBeNull()
  })
})
