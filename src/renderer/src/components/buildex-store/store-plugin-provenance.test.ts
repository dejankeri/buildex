import { describe, expect, it } from 'vitest'
import type { StorePluginSource } from '../../../../shared/buildex-store-types'
import { describePluginSource, pluginSourceWebUrl } from './store-plugin-provenance'

// The provenance line is the entire reason a plugin's source is kept, so the
// four spellings upstream's index actually uses are asserted here by name.
//
// These are the exact shapes `parseMarketplaceManifest` produces for those four
// — `marketplace-manifest.test.ts` ("reads the four source spellings upstream
// actually uses") is the other half of the contract. The parser lives in main
// and this formatter in the renderer, which is two typecheck projects, so the
// pair is written down twice rather than imported across the seam.

const FOUR_SPELLINGS: Record<string, StorePluginSource> = {
  // `{ source: 'git-subdir', url, path, ref, sha }`
  'git-subdir': {
    url: 'https://github.com/stripe/ai.git',
    path: 'providers/claude/plugin',
    pin: '84c364c'
  },
  // `{ source: 'url', url, sha }`
  url: { url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git', pin: '74e7c25' },
  // `{ source: 'github', repo, sha }`
  github: { url: 'https://github.com/fullstorydev/fullstory-skills.git', pin: 'b20614e' },
  // A bare string — a subdirectory of the marketplace repo itself.
  'marketplace-relative': { url: null, path: 'plugins/agent-sdk-dev' }
}

describe('describePluginSource', () => {
  it('says the same thing for all four spellings upstream uses', () => {
    expect(describePluginSource(FOUR_SPELLINGS['git-subdir'])).toBe(
      'https://github.com/stripe/ai.git (providers/claude/plugin) @ 84c364c'
    )
    expect(describePluginSource(FOUR_SPELLINGS.url)).toBe(
      'https://github.com/SalesforceAIResearch/agentforce-adlc.git @ 74e7c25'
    )
    expect(describePluginSource(FOUR_SPELLINGS.github)).toBe(
      'https://github.com/fullstorydev/fullstory-skills.git @ b20614e'
    )
    // A marketplace hosting the plugin itself adds nothing the dialog does not
    // already say by naming the marketplace.
    expect(describePluginSource(FOUR_SPELLINGS['marketplace-relative'])).toBeNull()
  })

  it('shortens a full commit so the line stays readable', () => {
    expect(
      describePluginSource({
        url: 'https://example.com/a.git',
        pin: '0123456789abcdef0123456789abcdef01234567'
      })
    ).toBe('https://example.com/a.git @ 0123456789ab')
  })
})

describe('pluginSourceWebUrl', () => {
  it('offers to open only the sources a browser can reach', () => {
    expect(pluginSourceWebUrl(FOUR_SPELLINGS['git-subdir'])).toBe('https://github.com/stripe/ai')
    expect(pluginSourceWebUrl(FOUR_SPELLINGS.url)).toBe(
      'https://github.com/SalesforceAIResearch/agentforce-adlc'
    )
    expect(pluginSourceWebUrl(FOUR_SPELLINGS.github)).toBe(
      'https://github.com/fullstorydev/fullstory-skills'
    )
    expect(pluginSourceWebUrl(FOUR_SPELLINGS['marketplace-relative'])).toBeNull()
  })

  it('refuses anything that is not https', () => {
    // The guard is doubled on purpose: this string reaches `shell.openUrl`, and
    // it is the only part of a plugin source this process ever acts on. The
    // parser already rejects a non-http(s) url; nothing downstream should have
    // to rely on that alone.
    expect(pluginSourceWebUrl({ url: 'http://example.com/a.git' })).toBeNull()
    expect(pluginSourceWebUrl({ url: 'file:///etc/passwd' })).toBeNull()
    expect(pluginSourceWebUrl({ url: 'git@github.com:a/b.git' })).toBeNull()
  })
})
