import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_CONFIG_RELATIVE_PATH, removeLegacyPackMcpServers } from './legacy-mcp-config-cleanup'

const repos: string[] = []

function repo(mcpConfig?: unknown | string): string {
  const created = mkdtempSync(path.join(tmpdir(), 'buildex-legacy-mcp-'))
  repos.push(created)
  if (mcpConfig !== undefined) {
    writeFileSync(
      path.join(created, MCP_CONFIG_RELATIVE_PATH),
      typeof mcpConfig === 'string' ? mcpConfig : JSON.stringify(mcpConfig, null, 2)
    )
  }
  return created
}

function config(repoPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoPath, MCP_CONFIG_RELATIVE_PATH), 'utf8'))
}

afterEach(() => {
  for (const created of repos.splice(0)) {
    rmSync(created, { recursive: true, force: true })
  }
})

describe('removeLegacyPackMcpServers', () => {
  it('deletes a file that held nothing but the servers we generated', () => {
    // Why: the plugin now carries this server. Leaving ours behind shows the
    // agent the same app twice.
    const repoPath = repo({
      mcpServers: {
        protocol: { type: 'http', url: 'https://api.protocolcrm.com/mcp' },
        stripe: { type: 'http', url: 'https://mcp.stripe.com' }
      }
    })

    const result = removeLegacyPackMcpServers(repoPath)

    expect(result).toEqual({ removedServerIds: ['protocol', 'stripe'], fileRemoved: true })
    expect(existsSync(path.join(repoPath, MCP_CONFIG_RELATIVE_PATH))).toBe(false)
  })

  it('keeps a server the operator added and only takes ours out', () => {
    const repoPath = repo({
      mcpServers: {
        protocol: { type: 'http', url: 'https://api.protocolcrm.com/mcp' },
        'our-internal-tools': { type: 'stdio', command: 'node tools.js' }
      }
    })

    const result = removeLegacyPackMcpServers(repoPath)

    expect(result.removedServerIds).toEqual(['protocol'])
    expect(result.fileRemoved).toBe(false)
    expect(Object.keys(config(repoPath).mcpServers as object)).toEqual(['our-internal-tools'])
  })

  it('keeps the file when it carries anything else of the operator’s', () => {
    const repoPath = repo({
      mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
      somethingElse: { theirs: true }
    })

    removeLegacyPackMcpServers(repoPath)

    expect(existsSync(path.join(repoPath, MCP_CONFIG_RELATIVE_PATH))).toBe(true)
    expect(config(repoPath).somethingElse).toEqual({ theirs: true })
  })

  it('leaves a file that was never ours completely alone', () => {
    const repoPath = repo({ mcpServers: { 'acme-internal': { type: 'stdio', command: 'x' } } })
    const before = readFileSync(path.join(repoPath, MCP_CONFIG_RELATIVE_PATH), 'utf8')

    expect(removeLegacyPackMcpServers(repoPath)).toEqual({
      removedServerIds: [],
      fileRemoved: false
    })
    expect(readFileSync(path.join(repoPath, MCP_CONFIG_RELATIVE_PATH), 'utf8')).toBe(before)
  })

  it('does not rewrite a file it cannot parse', () => {
    // Somebody's broken hand edit is theirs to fix, not ours to overwrite.
    const repoPath = repo('{ not json')

    expect(removeLegacyPackMcpServers(repoPath).removedServerIds).toEqual([])
    expect(readFileSync(path.join(repoPath, MCP_CONFIG_RELATIVE_PATH), 'utf8')).toBe('{ not json')
  })

  it('is silent on a repo that never had one', () => {
    expect(removeLegacyPackMcpServers(repo())).toEqual({
      removedServerIds: [],
      fileRemoved: false
    })
  })

  it('is safe to run twice', () => {
    const repoPath = repo({ mcpServers: { canva: { type: 'http', url: 'https://mcp.canva.com' } } })

    expect(removeLegacyPackMcpServers(repoPath).fileRemoved).toBe(true)
    expect(removeLegacyPackMcpServers(repoPath)).toEqual({
      removedServerIds: [],
      fileRemoved: false
    })
  })
})
