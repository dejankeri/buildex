import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MCP_CONFIG_RELATIVE_PATH } from '../buildex-packs/pack-mcp-config'

// Describing the MCP servers this repo hands the agent, without ever describing
// a secret.
//
// BuildEx's own entries reference keys as `${VAR}` and hold no value, but this
// file is the operator's too — a server added by hand can carry a pasted token
// in a header or an env value. Since this is rendered into a dialog somebody may
// well screenshot, anything that is not plainly a variable reference is masked.

export type McpServerEntry = Record<string, unknown>

const VARIABLE_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g

// What a scheme word like `Bearer` or `Basic` leaves behind once the reference
// is taken out. Anything longer than this is long enough to be a key.
const MAX_LEFTOVER = 8

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Servers in `.mcp.json`, sorted, so the dialog reads the same way every time. */
export function readMcpServers(repoPath: string): [string, McpServerEntry][] {
  const absolute = path.join(repoPath, ...MCP_CONFIG_RELATIVE_PATH.split('/'))
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'))
  } catch {
    return []
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return []
  }
  return Object.entries(parsed.mcpServers)
    .filter((pair): pair is [string, McpServerEntry] => isRecord(pair[1]))
    .sort((a, b) => a[0].localeCompare(b[0]))
}

/**
 * What a single header or env value is safe to say about itself.
 *
 * A value is shown as variable names only when it is made of `${VAR}` references
 * plus a scheme word — `Bearer ${TOKEN}` says everything useful and reveals
 * nothing. A value carrying anything longer than that has a literal in it, and a
 * literal in this position is a key, so the whole value is masked.
 */
export function describeSecret(value: string): string {
  const names = [...value.matchAll(VARIABLE_REFERENCE)].map((match) => match[1])
  const leftover = value.replace(VARIABLE_REFERENCE, '').replace(/\s+/g, '')
  if (names.length === 0 || leftover.length > MAX_LEFTOVER) {
    return '••••'
  }
  return names.map((name) => `$${name}`).join(', ')
}

/** Where each of a server's secrets comes from, deduplicated and sorted. */
export function secretSources(entry: McpServerEntry): string[] {
  const sources: string[] = []
  for (const key of ['headers', 'env']) {
    const bag = entry[key]
    if (!isRecord(bag)) {
      continue
    }
    for (const value of Object.values(bag)) {
      if (typeof value === 'string') {
        sources.push(describeSecret(value))
      }
    }
  }
  return [...new Set(sources)].sort()
}

/** One line: how the agent reaches this server, and where its key comes from. */
export function describeMcpServer(entry: McpServerEntry): string {
  const parts: string[] = []
  const url = typeof entry.url === 'string' ? entry.url : ''
  const command = typeof entry.command === 'string' ? entry.command : ''
  if (url) {
    parts.push(url)
  } else if (command) {
    parts.push(command)
  } else {
    parts.push(typeof entry.type === 'string' ? entry.type : 'server')
  }
  const secrets = secretSources(entry)
  if (secrets.length > 0) {
    parts.push(`key from ${secrets.join(', ')}`)
  }
  return parts.join(' · ')
}
