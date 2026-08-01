import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_MARKETPLACES, overlaysRootFrom, readStoreCatalog } from './marketplace-catalog'
import { isCuratedOverlay, readStoreOverlays } from './store-overlay'

// The curation that actually ships, read through the real parsers.
//
// The unit tests above prove the parsers; this proves the files. Overlays are
// the one part of the Store that still ships with the app — they are BuildEx's
// own curation, versioned with the release — so a typo in one silently drops an
// app's gate, its credential or its name, and nothing else in the suite notices.
//
// Marketplace indexes are deliberately NOT asserted here: they are fetched into
// a userData cache at runtime, so there is nothing on disk at build time to read.

const resourceRoot = path.resolve(__dirname, '..', '..', '..', 'resources')

function overlays(): ReturnType<typeof readStoreOverlays> {
  return readStoreOverlays(overlaysRootFrom(resourceRoot))
}

/**
 * The shelf those overlays produce over a stand-in index.
 *
 * `category` is upstream's own, and it matters: it is what the shelf falls back
 * to when no overlay names a plugin, so a placement test that left it out would
 * pass on the marketplace default alone.
 */
function shelfFor(
  pluginNames: Record<string, string[]>,
  category: string | null = null
): ReturnType<typeof readStoreCatalog> {
  return readStoreCatalog({
    marketplaces: KNOWN_MARKETPLACES.map((marketplace) => ({
      ...marketplace,
      indexBody: JSON.stringify({
        name: marketplace.id,
        plugins: (pluginNames[marketplace.id] ?? []).map((name) => ({
          name,
          description: `${name} from ${marketplace.id}`,
          ...(category ? { category } : {}),
          source: `./plugins/${name}`
        }))
      })
    })),
    overlays: overlays(),
    installed: new Set()
  })
}

/** The plugins upstream files under a business category that are dev tooling. */
const PLACED_AS_SOFTWARE = [
  'claude-code-setup',
  'claude-md-management',
  'code-review',
  'code-simplifier',
  'coderabbit',
  'commit-commands',
  'cwc-makers',
  'desktop-commander',
  'exa',
  'github',
  'gitlab',
  'hookify'
]

describe('the shipped overlays', () => {
  it('curate exactly the apps BuildEx wrote an overlay for', () => {
    expect(
      overlays()
        .filter((overlay) => isCuratedOverlay(overlay))
        .map((overlay) => `${overlay.pluginName}@${overlay.marketplaceId}`)
        .sort()
    ).toEqual([
      'asana@buildex-packs',
      'calendly@buildex-packs',
      'heygen@buildex-packs',
      'hubspot@buildex-packs',
      'linear@buildex-packs',
      'protocol-crm@protocol',
      'stripe@buildex-packs'
    ])
  })

  it('file upstream’s dev tooling on the software shelf without vouching for it', () => {
    // Upstream files every one of these under `productivity`, next to asana and
    // notion, so the category map alone puts `code-review` at the top of an
    // operator's shelf. The correction is data — one overlay per exception —
    // and it must stay placement only: a placed plugin is still unvetted, still
    // installs ungated, and must not wear the curated badge.
    const shelf = shelfFor({ 'claude-plugins-official': PLACED_AS_SOFTWARE }, 'productivity')

    for (const name of PLACED_AS_SOFTWARE) {
      const entry = shelf.entries.find((candidate) => candidate.plugin.name === name)
      expect(entry, name).toBeDefined()
      expect(entry?.segment, name).toBe('software')
      expect(entry?.curated, name).toBe(false)
    }
  })

  it('names every curated app the way an operator would say it', () => {
    // Why: a marketplace entry is not obliged to carry a displayName, and its
    // `name` is an identifier — a shelf of business apps reading `hubspot` and
    // `protocol-crm` is the wrong register.
    const shelf = shelfFor({
      'buildex-packs': ['stripe', 'linear', 'asana', 'hubspot', 'calendly', 'heygen'],
      protocol: ['protocol-crm']
    })

    expect(
      shelf.entries
        .filter((entry) => entry.curated)
        .map((entry) => entry.plugin.displayName)
        .sort()
    ).toEqual(['Asana', 'Calendly', 'HeyGen', 'HubSpot', 'Linear', 'Protocol', 'Stripe'])
  })

  it('puts every curated app on the business shelf', () => {
    const shelf = shelfFor({
      'buildex-packs': ['stripe', 'linear', 'asana', 'hubspot', 'calendly', 'heygen'],
      protocol: ['protocol-crm']
    })

    for (const entry of shelf.entries.filter((candidate) => candidate.curated)) {
      expect(entry.segment).toBe('business')
    }
  })

  it('does not curate upstream’s plugin of the same name', () => {
    // Our stripe is the operator's; stripe/ai's is the developer's. Same name,
    // different product — the overlay must not leak across.
    const shelf = shelfFor({
      'buildex-packs': ['stripe'],
      'claude-plugins-official': ['stripe']
    })
    const upstream = shelf.entries.find(
      (entry) => entry.marketplaceId === 'claude-plugins-official'
    )

    expect(upstream?.curated).toBe(false)
    expect(shelf.entries.find((entry) => entry.marketplaceId === 'buildex-packs')?.curated).toBe(
      true
    )
  })

  it('gates the verbs Protocol should never take unattended', () => {
    const protocol = overlays().find((overlay) => overlay.pluginName === 'protocol-crm')

    // A server delivered inside a plugin is namespaced by the plugin, so this is
    // the spelling that actually matches at runtime.
    expect(protocol?.gate?.ask).toContain('mcp__plugin_protocol-crm_protocol__manage_automations')
    expect(protocol?.apiKey?.envKey).toBe('PROTOCOL_MCP_API_KEY')
    expect(protocol?.systemOfRecord).toContain('lives in Protocol')
  })

  it('states which curated apps ship an MCP server, so Sign in is never a dead end', () => {
    const byName = new Map(overlays().map((overlay) => [overlay.pluginName, overlay]))

    expect(byName.get('protocol-crm')?.mcp).toBe(true)
    expect(byName.get('stripe')?.mcp).toBe(true)
    // HubSpot is a REST pack with no server of its own.
    expect(byName.get('hubspot')?.mcp).toBe(false)
  })
})
