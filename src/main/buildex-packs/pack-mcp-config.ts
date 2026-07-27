import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BuildExPack } from '../../shared/buildex-packs-types'
import { envKeyForPack } from './pack-credentials'

// Connect an installed pack's MCP server to the agent.
//
// The file is `.mcp.json` at the repo root. That is the project scope the agent
// runtime actually reads — `.claude/mcp.json` appears in some tools' candidate
// lists but Claude Code does not load project servers from it, so an earlier
// version of this wrote a file nothing ever read and installed packs silently
// had no tools.
//
// Generated, so it is excluded from the operator's git alongside `.claude/`:
// `.buildex/packs.json` is the tracked record, and this is derived from it on
// every run.
//
// The key is NEVER written here. The server entry references an environment
// variable, and the key itself stays encrypted in userData and is injected into
// the agent's terminal at launch. That way a repo copied to another machine, or
// a mis-set exclude, still leaks nothing.

export const MCP_CONFIG_RELATIVE_PATH = '.mcp.json'

type McpServerEntry = {
  type?: 'http' | 'stdio'
  url?: string
  command?: string
  headers?: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** The server entry for a pack, or null when the pack has no usable MCP face. */
export function buildMcpServerEntry(pack: BuildExPack): McpServerEntry | null {
  const mcp = pack.mcp
  if (!mcp) {
    return null
  }
  if (mcp.kind === 'http') {
    if (!mcp.url) {
      return null
    }
    const entry: McpServerEntry = { type: 'http', url: mcp.url }
    if (pack.apiKey?.transport === 'mcp-bearer') {
      // ${VAR} is expanded by the agent runtime when it reads this file, so the
      // token exists only in the process environment, never on disk here.
      entry.headers = { Authorization: `Bearer \${${envKeyForPack(pack)}}` }
    }
    return entry
  }
  if (!mcp.command) {
    return null
  }
  return { type: 'stdio', command: mcp.command }
}

export type McpConfigSyncResult = {
  changed: boolean
  /** Pack ids now present in the file. */
  serverIds: string[]
}

/**
 * Write the MCP servers for every installed pack, leaving servers the operator
 * added by hand exactly where they are.
 *
 * A pack that is uninstalled has its entry removed — but only if we are the ones
 * who put it there, which is why removal is keyed on the pack catalog rather
 * than on whatever happens to be in the file.
 */
export function syncPackMcpConfig(repoPath: string, packs: BuildExPack[]): McpConfigSyncResult {
  const absolute = path.join(repoPath, ...MCP_CONFIG_RELATIVE_PATH.split('/'))
  let current: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(absolute, 'utf8'))
    current = isRecord(parsed) ? parsed : {}
  } catch {
    current = {}
  }
  const servers = isRecord(current.mcpServers) ? { ...current.mcpServers } : {}

  const known = new Set(packs.map((pack) => pack.id))
  const serverIds: string[] = []
  for (const pack of packs) {
    const entry = pack.installed ? buildMcpServerEntry(pack) : null
    if (entry) {
      servers[pack.id] = entry
      serverIds.push(pack.id)
    } else if (known.has(pack.id) && pack.id in servers) {
      // The pack exists but is no longer installed (or lost its MCP face).
      delete servers[pack.id]
    }
  }

  const sorted: Record<string, unknown> = {}
  for (const id of Object.keys(servers).sort()) {
    sorted[id] = servers[id]
  }
  const next = `${JSON.stringify({ ...current, mcpServers: sorted }, null, 2)}\n`

  if (existsSync(absolute) && readFileSync(absolute, 'utf8') === next) {
    return { changed: false, serverIds: serverIds.sort() }
  }
  // Why: a repo with no MCP packs installed and no file should stay that way
  // rather than gaining an empty config.
  if (!existsSync(absolute) && Object.keys(sorted).length === 0) {
    return { changed: false, serverIds: [] }
  }
  try {
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, next, 'utf8')
    return { changed: true, serverIds: serverIds.sort() }
  } catch {
    return { changed: false, serverIds: serverIds.sort() }
  }
}
