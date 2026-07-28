import { describe, expect, it } from 'vitest'
import type { StorePlugin } from '../../shared/buildex-store-types'
import { segmentForPlugin } from './store-segments'

function plugin(name: string, category: string | null = null): StorePlugin {
  return {
    name,
    displayName: name,
    description: '',
    category,
    author: null,
    homepage: null,
    keywords: [],
    source: { kind: 'marketplace-relative', path: `plugins/${name}` }
  }
}

describe('segmentForPlugin', () => {
  it('puts the apps a business runs on the business shelf', () => {
    expect(segmentForPlugin(plugin('asana', 'productivity'), 'software', null)).toBe('business')
    expect(segmentForPlugin(plugin('canva', 'design'), 'software', null)).toBe('business')
    expect(segmentForPlugin(plugin('browser-use', 'automation'), 'software', null)).toBe('business')
  })

  it('keeps developer tooling off the business shelf despite its upstream category', () => {
    // Upstream files all of these under `productivity`, which is why the map
    // alone is not enough.
    expect(segmentForPlugin(plugin('github', 'productivity'), 'software', null)).toBe('software')
    expect(segmentForPlugin(plugin('code-review', 'productivity'), 'software', null)).toBe(
      'software'
    )
    expect(segmentForPlugin(plugin('commit-commands', 'productivity'), 'software', null)).toBe(
      'software'
    )
  })

  it('sends the developer categories to the software shelf', () => {
    expect(segmentForPlugin(plugin('stripe', 'development'), 'business', null)).toBe('software')
    expect(segmentForPlugin(plugin('clickhouse', 'database'), 'business', null)).toBe('software')
  })

  it('lets an overlay override everything, because BuildEx wrote it', () => {
    // Our own stripe pack is the operator's, even though upstream's stripe entry
    // is filed under development.
    expect(
      segmentForPlugin(plugin('stripe', 'development'), 'software', {
        pluginName: 'stripe',
        segment: 'business'
      })
    ).toBe('business')
    expect(
      segmentForPlugin(plugin('github', 'productivity'), 'business', {
        pluginName: 'github',
        segment: 'business'
      })
    ).toBe('business')
  })

  it('falls back to the marketplace default when a plugin states no category', () => {
    // A company's own marketplace categorises nothing; its plugins should still
    // land somewhere deliberate.
    expect(segmentForPlugin(plugin('acme-crm'), 'business', null)).toBe('business')
    expect(segmentForPlugin(plugin('acme-lint'), 'software', null)).toBe('software')
  })

  it('reads the category case-insensitively', () => {
    expect(segmentForPlugin(plugin('canva', 'Design'), 'software', null)).toBe('business')
  })
})
