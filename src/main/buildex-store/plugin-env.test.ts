import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreEntry, StoreOverlay } from '../../shared/buildex-store-types'

// The credential store reaches for the OS keychain; here it is absent, which is
// the same path a Linux box with no keyring takes in production.
vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v) }
}))

const { collectPluginEnv, collectPluginGateRules } = await import('./plugin-env')

const dirs: string[] = []

function userData(keys: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'buildex-userdata-'))
  dirs.push(root)
  const credentials = path.join(root, 'pack-credentials')
  mkdirSync(credentials, { recursive: true })
  for (const [pluginName, value] of Object.entries(keys)) {
    writeFileSync(path.join(credentials, `${pluginName}.enc`), value, 'utf8')
  }
  return root
}

function entry(
  name: string,
  installed: boolean,
  overlay: Partial<StoreOverlay> | null = null
): StoreEntry {
  return {
    plugin: {
      name,
      displayName: name,
      description: '',
      category: null,
      author: null,
      homepage: null,
      keywords: [],
      source: { kind: 'marketplace-relative', path: `plugins/${name}` }
    },
    marketplaceId: 'buildex-packs',
    marketplaceLabel: 'BuildEx',
    segment: 'business',
    curated: Boolean(overlay),
    overlay: overlay ? { pluginName: name, ...overlay } : null,
    installed
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('collectPluginEnv', () => {
  it('puts an installed plugin’s key into the agent’s environment', () => {
    const userDataPath = userData({ 'protocol-crm': 'pk_live_123' })

    const env = collectPluginEnv({ userDataPath }, [
      entry('protocol-crm', true, {
        apiKey: { transport: 'mcp-bearer', envKey: 'PROTOCOL_MCP_API_KEY' }
      })
    ])

    expect(env).toEqual({ PROTOCOL_MCP_API_KEY: 'pk_live_123' })
  })

  it('pairs a key with its API base, because skills read both', () => {
    const userDataPath = userData({ hubspot: 'tok' })

    const env = collectPluginEnv({ userDataPath }, [
      entry('hubspot', true, {
        apiKey: { transport: 'rest', apiBase: 'https://api.hubapi.com', envKey: 'HUBSPOT_API_KEY' }
      })
    ])

    expect(env).toEqual({
      HUBSPOT_API_KEY: 'tok',
      HUBSPOT_API_URL: 'https://api.hubapi.com'
    })
  })

  it('derives a variable name when the overlay does not state one', () => {
    const userDataPath = userData({ 'protocol-crm': 'k' })

    const env = collectPluginEnv({ userDataPath }, [
      entry('protocol-crm', true, { apiKey: { transport: 'mcp-bearer' } })
    ])

    // Hyphens are not legal in a shell variable name.
    expect(Object.keys(env)).toEqual(['BUILDEX_PROTOCOL_CRM_API_KEY'])
  })

  it('stops giving the agent a key once its plugin is uninstalled', () => {
    // Why: the key survives an uninstall on purpose, so reinstalling does not
    // mean pasting it again. It must not keep reaching the agent meanwhile.
    const userDataPath = userData({ stripe: 'rk_test' })

    expect(
      collectPluginEnv({ userDataPath }, [
        entry('stripe', false, { apiKey: { transport: 'mcp-bearer' } })
      ])
    ).toEqual({})
  })

  it('ignores a plugin nobody curated, and one with no key saved', () => {
    const userDataPath = userData()

    expect(
      collectPluginEnv({ userDataPath }, [
        entry('clickhouse', true, null),
        entry('stripe', true, { apiKey: { transport: 'mcp-bearer' } })
      ])
    ).toEqual({})
  })
})

describe('collectPluginGateRules', () => {
  it('collects the gated verbs of everything installed', () => {
    const rules = collectPluginGateRules([
      entry('protocol-crm', true, {
        gate: { ask: ['mcp__plugin_protocol-crm_protocol__schedule'] }
      }),
      entry('acme', true, { gate: { deny: ['mcp__acme__wipe'] } })
    ])

    expect(rules).toEqual({
      ask: ['mcp__plugin_protocol-crm_protocol__schedule'],
      deny: ['mcp__acme__wipe']
    })
  })

  it('does not gate on behalf of a plugin that is not installed', () => {
    expect(
      collectPluginGateRules([entry('protocol-crm', false, { gate: { ask: ['mcp__a__b'] } })])
    ).toEqual({ ask: [], deny: [] })
  })

  it('lists a rule once when two installed plugins both ask for it', () => {
    const rules = collectPluginGateRules([
      entry('one', true, { gate: { ask: ['mcp__shared__send'] } }),
      entry('two', true, { gate: { ask: ['mcp__shared__send'] } })
    ])

    expect(rules.ask).toEqual(['mcp__shared__send'])
  })
})
