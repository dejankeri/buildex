import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Taking back the `.mcp.json` an older BuildEx generated.
//
// Until this release BuildEx wrote a project-scoped `.mcp.json` with one server
// per installed pack. Plugins now carry their own server config, so on an
// upgraded repo the agent would see the app twice — once from the plugin and
// once from the file we left behind — and duplicate tools are worse than none.
//
// Only our own entries are removed, and only ones matching a pack we shipped. A
// server the operator added by hand stays exactly where they put it, and the
// file is deleted only when taking ours out leaves nothing.

export const MCP_CONFIG_RELATIVE_PATH = '.mcp.json'

/**
 * The pack ids an older BuildEx could have written a server for.
 *
 * A fixed list rather than "everything in the file": the catalog that produced
 * these entries no longer exists to be consulted, and guessing wider would take
 * out servers we never wrote.
 */
export const LEGACY_PACK_SERVER_IDS = [
  'asana',
  'calendly',
  'canva',
  'heygen',
  'hubspot',
  'intercom',
  'linear',
  'notion',
  'protocol',
  'slack',
  'stripe'
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export type LegacyMcpCleanupResult = {
  /** Server ids taken out, sorted. */
  removedServerIds: string[]
  /** True when nothing of ours was left and the file went with it. */
  fileRemoved: boolean
}

/**
 * Remove the servers a previous BuildEx generated from a repo's `.mcp.json`.
 *
 * Idempotent, and silent when there is nothing to do — which is the common case
 * on every repo after the first run.
 */
export function removeLegacyPackMcpServers(repoPath: string): LegacyMcpCleanupResult {
  const absolute = path.join(repoPath, MCP_CONFIG_RELATIVE_PATH)
  const empty: LegacyMcpCleanupResult = { removedServerIds: [], fileRemoved: false }
  if (!existsSync(absolute)) {
    return empty
  }

  let parsed: unknown
  let original: string
  try {
    original = readFileSync(absolute, 'utf8')
    parsed = JSON.parse(original)
  } catch {
    // A file we cannot read is not ours to rewrite.
    return empty
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return empty
  }

  const servers = { ...parsed.mcpServers }
  const removedServerIds: string[] = []
  for (const id of LEGACY_PACK_SERVER_IDS) {
    if (id in servers) {
      delete servers[id]
      removedServerIds.push(id)
    }
  }
  const otherKeys = Object.keys(parsed).filter((key) => key !== 'mcpServers')
  // Why: a repo that uninstalled its last pack under the old code kept an empty
  // `{"mcpServers":{}}`. There is nothing of ours to remove from it, but it is
  // still ours — and now that BuildEx no longer hides this file, leaving it is
  // leaving the operator a file to wonder about.
  const emptyAndOurs =
    removedServerIds.length === 0 && Object.keys(servers).length === 0 && otherKeys.length === 0
  if (removedServerIds.length === 0 && !emptyAndOurs) {
    return empty
  }

  if (Object.keys(servers).length === 0 && otherKeys.length === 0) {
    // Everything in it was ours; leaving an empty `{"mcpServers":{}}` behind
    // would be a file the operator has to wonder about.
    try {
      rmSync(absolute, { force: true })
      return { removedServerIds: removedServerIds.sort(), fileRemoved: true }
    } catch {
      return { removedServerIds: removedServerIds.sort(), fileRemoved: false }
    }
  }

  const sorted: Record<string, unknown> = {}
  for (const id of Object.keys(servers).sort()) {
    sorted[id] = servers[id]
  }
  try {
    writeFileSync(
      absolute,
      `${JSON.stringify({ ...parsed, mcpServers: sorted }, null, 2)}\n`,
      'utf8'
    )
  } catch {
    return empty
  }
  return { removedServerIds: removedServerIds.sort(), fileRemoved: false }
}
