import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { StoreApiKey, StoreGateRules, StoreOverlay } from '../../shared/buildex-store-types'

// What BuildEx adds to a plugin the marketplace does not carry: the ask-first
// gate, the credential its MCP server needs, and the system-of-record line the
// brain tells the agent.
//
// Keyed by plugin name rather than bundled into the plugin, so it survives that
// plugin being re-pinned, moved to another repo, or updated by its vendor. A
// plugin with no overlay still installs — it just runs ungated and says nothing
// about itself, which is the deliberate treatment for the long tail.
//
// These files ship with the app, so they are ours; they are still validated,
// because a gate rule the evaluator cannot parse is worse than no rule at all.

const PLUGIN_NAME_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asHttpUrl(value: unknown): string | null {
  const raw = asString(value)
  return raw && /^https?:\/\//i.test(raw) ? raw : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseRuleList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rules = new Set<string>()
  for (const entry of value) {
    const rule = asString(entry)
    // Why: these are written verbatim into `.claude/settings.json`, whose
    // grammar is `Tool` or `Tool(argPrefix:*)`. Anything with a newline or a
    // stray paren is not a rule the agent runtime can match, and a rule that
    // silently never matches reads as protection that is not there.
    if (rule && !/[\n\r]/.test(rule) && (rule.match(/\(/g) ?? []).length < 2) {
      rules.add(rule)
    }
  }
  return [...rules].sort()
}

function parseGate(value: unknown): StoreGateRules | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const ask = parseRuleList(value.ask)
  const deny = parseRuleList(value.deny)
  if (ask.length === 0 && deny.length === 0) {
    return undefined
  }
  return { ...(ask.length ? { ask } : {}), ...(deny.length ? { deny } : {}) }
}

function parseApiKey(value: unknown): StoreApiKey | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const transport =
    value.transport === 'mcp-bearer' || value.transport === 'rest' ? value.transport : null
  if (!transport) {
    return undefined
  }
  const apiKey: StoreApiKey = { transport }
  const apiBase = asHttpUrl(value.apiBase)
  if (apiBase) {
    apiKey.apiBase = apiBase
  }
  const docsUrl = asHttpUrl(value.docsUrl)
  if (docsUrl) {
    apiKey.docsUrl = docsUrl
  }
  const hint = asString(value.hint)
  if (hint) {
    apiKey.hint = hint
  }
  const envKey = asString(value.envKey)
  // Why: this becomes a variable name in a spawned shell.
  if (envKey && ENV_KEY_RE.test(envKey)) {
    apiKey.envKey = envKey
  }
  return apiKey
}

/** Parse one overlay file. Returns null when it names no plugin. */
export function parseStoreOverlay(json: string): StoreOverlay | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(raw)) {
    return null
  }
  const pluginName = asString(raw.pluginName)
  if (!pluginName || !PLUGIN_NAME_RE.test(pluginName)) {
    return null
  }
  const overlay: StoreOverlay = { pluginName }
  const marketplaceId = asString(raw.marketplaceId)
  if (marketplaceId) {
    overlay.marketplaceId = marketplaceId
  }
  if (raw.segment === 'business' || raw.segment === 'software') {
    overlay.segment = raw.segment
  }
  for (const key of ['icon', 'displayName', 'summary', 'systemOfRecord'] as const) {
    const parsed = asString(raw[key])
    if (parsed) {
      overlay[key] = parsed
    }
  }
  if (typeof raw.mcp === 'boolean') {
    overlay.mcp = raw.mcp
  }
  const apiKey = parseApiKey(raw.apiKey)
  if (apiKey) {
    overlay.apiKey = apiKey
  }
  const gate = parseGate(raw.gate)
  if (gate) {
    overlay.gate = gate
  }
  return overlay
}

/**
 * Every overlay that ships in `root`, indexed for lookup.
 *
 * A missing or unreadable directory is an empty index, not a failure: the Store
 * without overlays is the Store with nothing curated, which still browses and
 * still installs.
 */
export function readStoreOverlays(root: string): StoreOverlay[] {
  let entries: string[]
  try {
    entries = readdirSync(root).sort()
  } catch {
    return []
  }
  const overlays: StoreOverlay[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue
    }
    try {
      const overlay = parseStoreOverlay(readFileSync(path.join(root, entry), 'utf8'))
      if (overlay) {
        overlays.push(overlay)
      }
    } catch {
      // One unreadable overlay costs that plugin its curation, nothing more.
    }
  }
  return overlays
}

/**
 * Find the overlay for a plugin.
 *
 * An overlay naming a marketplace wins over an unscoped one, which is what makes
 * "our stripe" and "upstream's stripe" separable — they share a name and are
 * different products.
 */
export function findOverlay(
  overlays: readonly StoreOverlay[],
  pluginName: string,
  marketplaceId: string
): StoreOverlay | null {
  let unscoped: StoreOverlay | null = null
  for (const overlay of overlays) {
    if (overlay.pluginName !== pluginName) {
      continue
    }
    if (overlay.marketplaceId === marketplaceId) {
      return overlay
    }
    if (!overlay.marketplaceId) {
      unscoped = overlay
    }
  }
  return unscoped
}
