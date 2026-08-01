import type {
  StoreMarketplaceManifest,
  StorePlugin,
  StorePluginSource
} from '../../shared/buildex-store-types'

// Parsing for a marketplace.json. The index is fetched from a git repo BuildEx
// does not own — Anthropic's, a vendor's, or whatever URL a company pasted — so
// every field is untrusted. A malformed entry is skipped rather than emptying a
// 276-row shelf, and the two fields this process itself acts on — the plugin
// name it asks the CLI to install, and any URL it may be asked to open — are
// checked before they can be either.

const PLUGIN_NAME_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i

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

/**
 * A name from `author: {name}` or a bare `author: "…"`, whichever the index used.
 */
function parseAuthor(value: unknown): string | null {
  if (isRecord(value)) {
    return asString(value.name)
  }
  return asString(value)
}

function parseKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const keywords = new Set<string>()
  for (const entry of value) {
    const keyword = asString(entry)
    if (keyword) {
      keywords.add(keyword)
    }
  }
  return [...keywords]
}

/**
 * Where the plugin's bytes come from, flattened for display.
 *
 * Deliberately not validated as a path: no code here ever resolves it. Installing
 * hands `claude plugin install <name>@<marketplace>` a name and a marketplace
 * repo, and the CLI reads the source out of the clone it made itself, so a `..`
 * in this string reaches nothing of ours. The URL is still required to be
 * http(s), because that one *is* acted on here — the provenance line offers to
 * open it.
 */
function parseSource(value: unknown): StorePluginSource | null {
  // The bare-string spelling: a subdirectory of the marketplace repo itself.
  const inline = asString(value)
  if (inline) {
    return { url: null, path: inline.replace(/^\.\//, '').replace(/\/+$/, '') }
  }
  if (!isRecord(value)) {
    return null
  }
  // The `github` spelling names a repo; the other two carry a URL.
  const repo = asString(value.repo)
  const url = repo ? `https://github.com/${repo}.git` : asHttpUrl(value.url)
  if (!url) {
    return null
  }
  const subPath = asString(value.path)
  const pin = asString(value.sha) ?? asString(value.commit) ?? asString(value.ref)
  return { url, ...(subPath ? { path: subPath } : {}), ...(pin ? { pin } : {}) }
}

function parsePlugin(value: unknown): StorePlugin | null {
  if (!isRecord(value)) {
    return null
  }
  const name = asString(value.name)
  // Why: the name is what the agent's CLI is asked to install, so it has to be
  // an identifier and not an argument.
  if (!name || !PLUGIN_NAME_RE.test(name)) {
    return null
  }
  const source = parseSource(value.source)
  if (!source) {
    return null
  }
  return {
    name,
    displayName: asString(value.displayName) ?? name,
    description: asString(value.description) ?? '',
    category: asString(value.category),
    author: parseAuthor(value.author),
    homepage: asHttpUrl(value.homepage),
    keywords: parseKeywords(value.keywords),
    source
  }
}

/** Parse a marketplace.json body. Returns null when it is not a marketplace. */
export function parseMarketplaceManifest(json: string): StoreMarketplaceManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(raw)) {
    return null
  }
  const name = asString(raw.name)
  if (!name || !Array.isArray(raw.plugins)) {
    return null
  }

  // Keyed by name: upstream re-lists an entry when it re-pins, and the later row
  // is the current one.
  const plugins = new Map<string, StorePlugin>()
  for (const entry of raw.plugins) {
    const plugin = parsePlugin(entry)
    if (plugin) {
      plugins.set(plugin.name, plugin)
    }
  }

  return { name, owner: parseAuthor(raw.owner), plugins: [...plugins.values()] }
}
