import type {
  BuildExPack,
  PackApiKeyFace,
  PackAppFace,
  PackMcpFace
} from '../../shared/buildex-packs-types'

// Parsing and validation for a pack.json. Manifests are authored by hand and
// arrive from a company repo, so every field is treated as untrusted: a
// malformed pack is skipped rather than crashing the Store or, worse, being
// half-installed.

const PACK_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseAppFace(value: unknown): PackAppFace | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const url = asString((value as { url?: unknown }).url)
  // Why: an app face becomes a clickable link. Restricting to http(s) keeps a
  // manifest from smuggling file:// or a custom scheme into the shell opener.
  if (!url || !/^https?:\/\//i.test(url)) {
    return undefined
  }
  return { url }
}

function parseMcpFace(value: unknown): PackMcpFace | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const raw = value as { kind?: unknown; url?: unknown; command?: unknown; direct?: unknown }
  const kind = raw.kind === 'http' || raw.kind === 'stdio' ? raw.kind : null
  if (!kind) {
    return undefined
  }
  const face: PackMcpFace = { kind }
  const url = asString(raw.url)
  if (url) {
    face.url = url
  }
  const command = asString(raw.command)
  if (command) {
    face.command = command
  }
  if (raw.direct === true) {
    face.direct = true
  }
  return face
}

function parseApiKeyFace(value: unknown): PackApiKeyFace | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const transport =
    raw.transport === 'mcp-bearer' || raw.transport === 'rest' ? raw.transport : null
  if (!transport) {
    return undefined
  }
  const face: PackApiKeyFace = { transport }
  const apiBase = asString(raw.apiBase)
  // Why: an api base is a URL the skills will call. Same reasoning as the app
  // face — restrict the scheme so a manifest cannot point it somewhere local.
  if (apiBase && /^https?:\/\//i.test(apiBase)) {
    face.apiBase = apiBase
  }
  const docsUrl = asString(raw.docsUrl)
  if (docsUrl && /^https?:\/\//i.test(docsUrl)) {
    face.docsUrl = docsUrl
  }
  const hint = asString(raw.hint)
  if (hint) {
    face.hint = hint
  }
  const envKey = asString(raw.envKey)
  // Why: this becomes an environment variable name in a spawned shell.
  if (envKey && /^[A-Z][A-Z0-9_]*$/.test(envKey)) {
    face.envKey = envKey
  }
  return face
}

function parseSkills(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const skills = new Set<string>()
  for (const entry of value) {
    const skill = asString(entry)
    // Why: skill names become directory names under skills/. Rejecting anything
    // outside the id charset stops a manifest writing through `../`.
    if (skill && PACK_ID_RE.test(skill)) {
      skills.add(skill)
    }
  }
  return [...skills].sort()
}

/**
 * What a manifest can state about itself. Where it came from and whether it is
 * installed are facts about the catalog and the repo, not the file, so they are
 * filled in by the catalog reader.
 */
export type ParsedPackManifest = Omit<BuildExPack, 'installed' | 'sourceDir' | 'source'>

/** Parse a pack.json body. Returns null when the manifest is unusable. */
export function parsePackManifest(json: string, manifestPath: string): ParsedPackManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  const id = asString(record.id)
  if (!id || !PACK_ID_RE.test(id)) {
    return null
  }
  const name = asString(record.name)
  if (!name) {
    return null
  }
  return {
    id,
    name,
    icon: asString(record.icon) ?? '📦',
    summary: asString(record.summary) ?? '',
    app: parseAppFace(record.app),
    mcp: parseMcpFace(record.mcp),
    apiKey: parseApiKeyFace(record.apiKey),
    skills: parseSkills(record.skills),
    manifestPath
  }
}
