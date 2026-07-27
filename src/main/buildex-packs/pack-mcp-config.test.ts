import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BuildExPack } from '../../shared/buildex-packs-types'
import { buildMcpServerEntry, syncPackMcpConfig } from './pack-mcp-config'

let repo = ''

function pack(overrides: Partial<BuildExPack> = {}): BuildExPack {
  return {
    id: 'protocol',
    name: 'Protocol',
    icon: '🏋️',
    summary: '',
    skills: ['protocol-reference'],
    manifestPath: 'protocol/pack.json',
    sourceDir: '/catalog/protocol',
    source: 'bundle',
    installed: true,
    ...overrides
  }
}

function readConfig(): { mcpServers: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(path.join(repo, '.mcp.json'), 'utf8'))
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-mcp-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('buildMcpServerEntry', () => {
  it('references the key by environment variable, never its value', () => {
    const entry = buildMcpServerEntry(
      pack({
        mcp: { kind: 'http', url: 'https://api.protocolcrm.com/mcp' },
        apiKey: { transport: 'mcp-bearer' }
      })
    )

    expect(entry).toEqual({
      type: 'http',
      url: 'https://api.protocolcrm.com/mcp',
      headers: { Authorization: 'Bearer ${BUILDEX_PROTOCOL_API_KEY}' }
    })
  })

  it('honours an envKey the manifest names', () => {
    const entry = buildMcpServerEntry(
      pack({
        mcp: { kind: 'http', url: 'https://x.dev/mcp' },
        apiKey: { transport: 'mcp-bearer', envKey: 'PROTOCOL_API_KEY' }
      })
    )

    expect(entry?.headers?.Authorization).toBe('Bearer ${PROTOCOL_API_KEY}')
  })

  it('adds no auth header for a pack that needs no key', () => {
    const entry = buildMcpServerEntry(pack({ mcp: { kind: 'http', url: 'https://x.dev/mcp' } }))

    expect(entry).toEqual({ type: 'http', url: 'https://x.dev/mcp' })
  })

  it('ignores an http face with no url and a stdio face with no command', () => {
    expect(buildMcpServerEntry(pack({ mcp: { kind: 'http' } }))).toBeNull()
    expect(buildMcpServerEntry(pack({ mcp: { kind: 'stdio' } }))).toBeNull()
    expect(buildMcpServerEntry(pack())).toBeNull()
  })
})

describe('syncPackMcpConfig', () => {
  it('writes the server for an installed pack', () => {
    const result = syncPackMcpConfig(repo, [
      pack({ mcp: { kind: 'http', url: 'https://x.dev/mcp' } })
    ])

    expect(result.serverIds).toEqual(['protocol'])
    expect(readConfig().mcpServers.protocol).toBeDefined()
  })

  it('writes no file at all when nothing needs one', () => {
    syncPackMcpConfig(repo, [pack({ installed: false })])

    expect(existsSync(path.join(repo, '.mcp.json'))).toBe(false)
  })

  it('never contains the key itself', () => {
    syncPackMcpConfig(repo, [
      pack({ mcp: { kind: 'http', url: 'https://x.dev/mcp' }, apiKey: { transport: 'mcp-bearer' } })
    ])

    const body = readFileSync(path.join(repo, '.mcp.json'), 'utf8')
    expect(body).toContain('${BUILDEX_PROTOCOL_API_KEY}')
    expect(body).not.toMatch(/pk_|xoxb-|sk_/)
  })

  it('removes the server when the pack is uninstalled', () => {
    syncPackMcpConfig(repo, [pack({ mcp: { kind: 'http', url: 'https://x.dev/mcp' } })])
    syncPackMcpConfig(repo, [
      pack({ mcp: { kind: 'http', url: 'https://x.dev/mcp' }, installed: false })
    ])

    expect(readConfig().mcpServers.protocol).toBeUndefined()
  })

  it('leaves a server the operator added by hand alone', () => {
    syncPackMcpConfig(repo, [pack({ mcp: { kind: 'http', url: 'https://x.dev/mcp' } })])
    const config = readConfig()
    config.mcpServers.mine = { type: 'stdio', command: 'my-server' }
    writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify(config, null, 2), 'utf8')

    syncPackMcpConfig(repo, [pack({ mcp: { kind: 'http', url: 'https://x.dev/mcp' } })])

    expect(readConfig().mcpServers.mine).toEqual({ type: 'stdio', command: 'my-server' })
  })

  it('is idempotent', () => {
    const packs = [pack({ mcp: { kind: 'http', url: 'https://x.dev/mcp' } })]
    syncPackMcpConfig(repo, packs)

    expect(syncPackMcpConfig(repo, packs).changed).toBe(false)
  })
})
