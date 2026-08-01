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
    source: { url: null, path: `plugins/${name}` }
  }
}

describe('segmentForPlugin', () => {
  it('puts the apps a business runs on the business shelf', () => {
    expect(segmentForPlugin(plugin('asana', 'productivity'), 'software', null)).toBe('business')
    expect(segmentForPlugin(plugin('canva', 'design'), 'software', null)).toBe('business')
    expect(segmentForPlugin(plugin('browser-use', 'automation'), 'software', null)).toBe('business')
  })

  it('takes a placement overlay that carries nothing else', () => {
    // Upstream files github and code-review under `productivity`, which is why
    // the category map alone is not enough. The exceptions are overlay files
    // now, so this is the only mechanism that has to work — which plugins use it
    // is asserted against the shipped files in bundled-shelf.test.ts.
    expect(
      segmentForPlugin(plugin('github', 'productivity'), 'business', {
        pluginName: 'github',
        segment: 'software'
      })
    ).toBe('software')
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
