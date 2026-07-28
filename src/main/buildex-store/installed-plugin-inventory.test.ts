import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoreEntry, StorePlugin } from '../../shared/buildex-store-types'
import {
  readInstalledPluginInventory,
  readInstalledPluginPaths,
  readPluginShape
} from './installed-plugin-inventory'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'buildex-inventory-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** An unpacked plugin on disk, as the agent's cache holds it. */
function writePlugin(
  name: string,
  contents: { skills?: string[]; mcp?: boolean; files?: string[] } = {}
): string {
  const installPath = path.join(home, '.claude', 'plugins', 'cache', name, '1.0.0')
  mkdirSync(installPath, { recursive: true })
  for (const skill of contents.skills ?? []) {
    mkdirSync(path.join(installPath, 'skills', skill), { recursive: true })
  }
  for (const file of contents.files ?? []) {
    writeFileSync(path.join(installPath, 'skills', file), '', 'utf8')
  }
  if (contents.mcp) {
    writeFileSync(path.join(installPath, '.mcp.json'), '{"mcpServers":{}}', 'utf8')
  }
  return installPath
}

function writeInstalledPlugins(raw: unknown): void {
  const dir = path.join(home, '.claude', 'plugins')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'installed_plugins.json'),
    typeof raw === 'string' ? raw : JSON.stringify(raw),
    'utf8'
  )
}

function record(installPath: string): Record<string, unknown> {
  return { scope: 'user', installPath, version: '1.0.0' }
}

function plugin(name: string, description = `${name} description`): StorePlugin {
  return {
    name,
    displayName: name.toUpperCase(),
    description,
    category: null,
    author: null,
    homepage: null,
    keywords: [],
    source: { kind: 'git', url: `https://example.test/${name}` }
  }
}

function entry(name: string, overrides: Partial<StoreEntry> = {}): StoreEntry {
  return {
    plugin: plugin(name),
    marketplaceId: 'buildex-packs',
    marketplaceLabel: 'BuildEx',
    segment: 'business',
    curated: false,
    overlay: null,
    installed: true,
    ...overrides
  }
}

describe('readInstalledPluginPaths', () => {
  it('keys install paths by plugin@marketplace', () => {
    const installPath = writePlugin('stripe')
    writeInstalledPlugins({
      version: 2,
      plugins: { 'stripe@buildex-packs': [record(installPath)] }
    })
    expect(readInstalledPluginPaths(home).get('stripe@buildex-packs')).toBe(installPath)
  })

  it('skips an entry whose install list is empty', () => {
    writeInstalledPlugins({ version: 2, plugins: { 'stripe@buildex-packs': [] } })
    expect(readInstalledPluginPaths(home).size).toBe(0)
  })

  it('takes the first record that actually names a path', () => {
    const installPath = writePlugin('stripe')
    writeInstalledPlugins({
      version: 2,
      plugins: { 'stripe@buildex-packs': [{ scope: 'user' }, record(installPath)] }
    })
    expect(readInstalledPluginPaths(home).get('stripe@buildex-packs')).toBe(installPath)
  })

  it('is empty for a missing file, malformed JSON, and a wrong-shaped document', () => {
    expect(readInstalledPluginPaths(home).size).toBe(0)
    writeInstalledPlugins('{ not json')
    expect(readInstalledPluginPaths(home).size).toBe(0)
    writeInstalledPlugins({ version: 2, plugins: 'nope' })
    expect(readInstalledPluginPaths(home).size).toBe(0)
  })
})

describe('readPluginShape', () => {
  it('lists skill directories and finds the MCP config', () => {
    const installPath = writePlugin('canva', { skills: ['brand-check', 'bulk-create'], mcp: true })
    expect(readPluginShape(installPath)).toEqual({
      skills: ['brand-check', 'bulk-create'],
      hasMcp: true
    })
  })

  it('reports no skills for the quarter of plugins that ship none', () => {
    const installPath = writePlugin('playwright', { mcp: true })
    expect(readPluginShape(installPath)).toEqual({ skills: [], hasMcp: true })
  })

  it('ignores files and dotfiles inside skills/', () => {
    const installPath = writePlugin('linear', {
      skills: ['.hidden', 'triage'],
      files: ['README.md']
    })
    expect(readPluginShape(installPath).skills).toEqual(['triage'])
  })

  it('sorts skills so the context renders the same way every time', () => {
    const installPath = writePlugin('notion', { skills: ['research', 'capture', 'meetings'] })
    expect(readPluginShape(installPath).skills).toEqual(['capture', 'meetings', 'research'])
  })

  it('yields an empty shape for an absent path and for no path at all', () => {
    expect(readPluginShape(path.join(home, 'nowhere'))).toEqual({ skills: [], hasMcp: false })
    expect(readPluginShape(undefined)).toEqual({ skills: [], hasMcp: false })
  })
})

describe('readInstalledPluginInventory', () => {
  it('describes an installed plugin from its marketplace text and its contents', () => {
    const installPath = writePlugin('stripe', { skills: ['stripe-docs'], mcp: true })
    writeInstalledPlugins({
      version: 2,
      plugins: { 'stripe@buildex-packs': [record(installPath)] }
    })
    expect(readInstalledPluginInventory(home, [entry('stripe')])).toEqual([
      {
        id: 'stripe',
        name: 'STRIPE',
        summary: 'stripe description',
        skills: ['stripe-docs'],
        hasMcp: true
      }
    ])
  })

  it('leaves out plugins that are not installed', () => {
    writeInstalledPlugins({ version: 2, plugins: {} })
    expect(readInstalledPluginInventory(home, [entry('stripe', { installed: false })])).toEqual([])
  })

  it('prefers the overlay summary over the marketplace description', () => {
    const installPath = writePlugin('linear')
    writeInstalledPlugins({
      version: 2,
      plugins: { 'linear@buildex-packs': [record(installPath)] }
    })
    const [summary] = readInstalledPluginInventory(home, [
      entry('linear', { curated: true, overlay: { pluginName: 'linear', summary: 'BuildEx says' } })
    ])
    expect(summary.summary).toBe('BuildEx says')
  })

  it('names the env key and reports the credential only when the overlay wants one', () => {
    const installPath = writePlugin('protocol', { mcp: true })
    writeInstalledPlugins({
      version: 2,
      plugins: { 'protocol@buildex-packs': [record(installPath)] }
    })
    const overlay = {
      pluginName: 'protocol',
      apiKey: { transport: 'mcp-bearer' as const, envKey: 'PROTOCOL_API_KEY' }
    }
    expect(
      readInstalledPluginInventory(home, [
        entry('protocol', { overlay, credentialConnected: true })
      ])[0]
    ).toMatchObject({ envKey: 'PROTOCOL_API_KEY', connected: true })
    expect(
      readInstalledPluginInventory(home, [
        entry('protocol', { overlay, credentialConnected: false })
      ])[0]
    ).toMatchObject({ connected: false })
    expect(readInstalledPluginInventory(home, [entry('protocol')])[0]).not.toHaveProperty('envKey')
  })

  it('derives an env key when the overlay names none', () => {
    const installPath = writePlugin('heygen')
    writeInstalledPlugins({
      version: 2,
      plugins: { 'heygen@buildex-packs': [record(installPath)] }
    })
    const [summary] = readInstalledPluginInventory(home, [
      entry('heygen', {
        overlay: { pluginName: 'heygen', apiKey: { transport: 'rest' } }
      })
    ])
    expect(summary.envKey).toBe('BUILDEX_HEYGEN_API_KEY')
  })

  it('matches a plugin to its install by marketplace, not by name alone', () => {
    const installPath = writePlugin('stripe', { skills: ['ours'] })
    writeInstalledPlugins({
      version: 2,
      plugins: { 'stripe@buildex-packs': [record(installPath)] }
    })
    const [summary] = readInstalledPluginInventory(home, [
      entry('stripe', { marketplaceId: 'claude-plugins-official' })
    ])
    // Why: the same name in two marketplaces is two different products, and
    // borrowing one's contents for the other would describe an app that is not there.
    expect(summary.skills).toEqual([])
  })

  it('describes a plugin whose install path is gone rather than throwing', () => {
    writeInstalledPlugins({
      version: 2,
      plugins: { 'ghost@buildex-packs': [record(path.join(home, 'removed'))] }
    })
    expect(readInstalledPluginInventory(home, [entry('ghost')])[0]).toMatchObject({
      skills: [],
      hasMcp: false
    })
  })
})
