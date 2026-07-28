import type {
  StoreMarketplaceManifest,
  StorePlugin,
  StorePluginSource
} from '../../shared/buildex-store-types'

// Parsing for a marketplace.json. The index is fetched from a git repo BuildEx
// does not own — Anthropic's, a vendor's, or whatever URL a company pasted — so
// every field is untrusted. A malformed entry is skipped rather than emptying a
// 276-row shelf, and anything that would become a path or a URL is checked
// before it can be either.

const PLUGIN_NAME_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i
const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/

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
 * A path inside the marketplace repo. Anything absolute or reaching upward is
 * rejected: the agent's CLI resolves this against the cloned marketplace, so
 * `..` would point it at whatever sits beside the clone on disk.
 */
function parseRelativePath(raw: string): string | null {
  const trimmed = raw.replace(/^\.\//, '').replace(/\/+$/, '')
  if (!trimmed || trimmed.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(trimmed)) {
    return null
  }
  // A Windows-style absolute path is equally not a subdirectory of the repo.
  if (/^[a-z]:[\\/]/i.test(trimmed) || trimmed.includes('\\')) {
    return null
  }
  return trimmed
}

function parseSource(value: unknown): StorePluginSource | null {
  // The bare-string spelling: a subdirectory of the marketplace repo itself.
  const inline = asString(value)
  if (inline) {
    const path = parseRelativePath(inline)
    return path ? { kind: 'marketplace-relative', path } : null
  }
  if (!isRecord(value)) {
    return null
  }
  const kind = asString(value.source)

  // `github` names a repo rather than a URL; everything else carries one.
  if (kind === 'github') {
    const repo = asString(value.repo)
    if (!repo || !REPO_SLUG_RE.test(repo)) {
      return null
    }
    const source: StorePluginSource = { kind: 'git', url: `https://github.com/${repo}.git` }
    const sha = asString(value.sha) ?? asString(value.commit)
    if (sha) {
      source.sha = sha
    }
    return source
  }

  if (kind !== 'git-subdir' && kind !== 'url') {
    return null
  }
  const url = asHttpUrl(value.url)
  if (!url) {
    return null
  }
  const source: StorePluginSource = { kind: 'git', url }
  const subPath = asString(value.path)
  if (subPath) {
    const relative = parseRelativePath(subPath)
    if (!relative) {
      return null
    }
    source.path = relative
  }
  const ref = asString(value.ref)
  if (ref) {
    source.ref = ref
  }
  const sha = asString(value.sha)
  if (sha) {
    source.sha = sha
  }
  return source
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
