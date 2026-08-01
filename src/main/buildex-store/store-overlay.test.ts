import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StoreOverlay } from '../../shared/buildex-store-types'
import { findOverlay, parseStoreOverlay, readStoreOverlays } from './store-overlay'

const roots: string[] = []

function overlayRoot(files: Record<string, unknown | string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'buildex-overlays-'))
  roots.push(root)
  mkdirSync(root, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, name), typeof body === 'string' ? body : JSON.stringify(body))
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('parseStoreOverlay', () => {
  it('reads the whole of what BuildEx adds to a plugin', () => {
    const overlay = parseStoreOverlay(
      JSON.stringify({
        pluginName: 'protocol',
        marketplaceId: 'protocol',
        segment: 'business',
        icon: '🏋️',
        summary: 'Coaching CRM.',
        systemOfRecord: 'Every client lives in Protocol.',
        apiKey: {
          transport: 'mcp-bearer',
          docsUrl: 'https://help.protocolcrm.com/ai-agent/connecting',
          hint: 'Agent key (pk_…)',
          envKey: 'PROTOCOL_API_KEY'
        },
        gate: { ask: ['mcp__protocol__schedule', 'mcp__protocol__manage_automations'] }
      })
    )

    expect(overlay).toMatchObject({
      pluginName: 'protocol',
      marketplaceId: 'protocol',
      segment: 'business',
      systemOfRecord: 'Every client lives in Protocol.',
      apiKey: { transport: 'mcp-bearer', envKey: 'PROTOCOL_API_KEY' },
      gate: { ask: ['mcp__protocol__manage_automations', 'mcp__protocol__schedule'] }
    })
  })

  it('drops a gate rule outside the permission grammar and keeps the ones inside it', () => {
    // Why: these rules are written verbatim into `.claude/settings.json`, whose
    // grammar is `Tool` or `Tool(argPrefix:*)`. A rule the agent runtime cannot
    // match is protection that looks present and is not — so the grammar check
    // has to survive the in-app evaluator that used to sit beside it.
    const overlay = parseStoreOverlay(
      JSON.stringify({
        pluginName: 'acme',
        gate: {
          ask: [
            'Bash(rm -rf:*)',
            'Bash(git push*)',
            'mcp__protocol__schedule',
            'Two(paren)(rules)',
            'with\nnewline',
            'carriage\rreturn',
            '  '
          ],
          deny: ['WebFetch', 'still(two)(parens)']
        }
      })
    )

    expect(overlay?.gate).toEqual({
      ask: ['Bash(git push*)', 'Bash(rm -rf:*)', 'mcp__protocol__schedule'],
      deny: ['WebFetch']
    })
  })

  it('refuses an env key that is not a shell variable name', () => {
    const overlay = parseStoreOverlay(
      JSON.stringify({
        pluginName: 'acme',
        apiKey: { transport: 'rest', envKey: 'PATH; rm -rf /' }
      })
    )

    expect(overlay?.apiKey).toEqual({ transport: 'rest' })
  })

  it('refuses a docs URL that is not http(s)', () => {
    const overlay = parseStoreOverlay(
      JSON.stringify({
        pluginName: 'acme',
        apiKey: { transport: 'rest', docsUrl: 'file:///etc/passwd' }
      })
    )

    expect(overlay?.apiKey).toEqual({ transport: 'rest' })
  })

  it('returns null when the file names no plugin', () => {
    expect(parseStoreOverlay('not json')).toBeNull()
    expect(parseStoreOverlay(JSON.stringify({ icon: '📦' }))).toBeNull()
    expect(parseStoreOverlay(JSON.stringify({ pluginName: 'Bad Name!' }))).toBeNull()
  })
})

describe('readStoreOverlays', () => {
  it('reads every overlay and ignores what is not one', () => {
    const root = overlayRoot({
      'protocol.json': { pluginName: 'protocol', icon: '🏋️' },
      'stripe.json': { pluginName: 'stripe', icon: '💳' },
      'broken.json': '{ not json',
      'README.md': '# not an overlay'
    })

    expect(readStoreOverlays(root).map((overlay) => overlay.pluginName)).toEqual([
      'protocol',
      'stripe'
    ])
  })

  it('treats a missing directory as nothing curated rather than a failure', () => {
    // The Store with no overlays still browses and still installs.
    expect(readStoreOverlays(path.join(tmpdir(), 'buildex-overlays-does-not-exist'))).toEqual([])
  })
})

describe('findOverlay', () => {
  const overlays: StoreOverlay[] = [
    { pluginName: 'stripe', marketplaceId: 'buildex-packs', summary: 'ours' },
    { pluginName: 'canva', summary: 'unscoped' }
  ]

  it('separates our plugin from upstream’s of the same name', () => {
    // The whole point: two Stripes, two products, one name.
    expect(findOverlay(overlays, 'stripe', 'buildex-packs')?.summary).toBe('ours')
    expect(findOverlay(overlays, 'stripe', 'claude-plugins-official')).toBeNull()
  })

  it('applies an unscoped overlay to whichever marketplace carries the plugin', () => {
    expect(findOverlay(overlays, 'canva', 'claude-plugins-official')?.summary).toBe('unscoped')
  })

  it('has nothing to say about a plugin nobody curated', () => {
    expect(findOverlay(overlays, 'clickhouse', 'claude-plugins-official')).toBeNull()
  })
})
