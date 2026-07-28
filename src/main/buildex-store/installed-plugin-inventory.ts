import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { StoreEntry } from '../../shared/buildex-store-types'
import type { InstalledAppSummary } from '../buildex-brain/company-context'
import { INSTALLED_PLUGINS_RELATIVE_PATH } from './claude-plugin-install'
import { installKey } from './marketplace-catalog'
import { envKeyForPlugin } from './plugin-credentials'

// What an installed plugin actually turned out to be, read off disk.
//
// A marketplace index says a plugin's name and description and nothing about its
// shape — whether it carries skills, whether it brings an MCP server. The agent
// needs both to tell the operator what it can now do, and only the unpacked
// plugin knows. A quarter of the shelf has no `skills/` at all, so an absent
// directory is an ordinary answer here, not a failure.
//
// Deliberately free of electron: `credentialConnected` is stamped at the IPC
// boundary, so nothing here has to know where keys live.

/** Enough directory entries to cover any real plugin; a runaway tree stops here. */
const MAX_SKILLS = 200

type PluginShape = { skills: string[]; hasMcp: boolean }

const EMPTY_SHAPE: PluginShape = { skills: [], hasMcp: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Where the agent unpacked each installed plugin, keyed `plugin@marketplace`.
 *
 * The first install record wins: an entry is a list across scopes, and a plugin
 * installed both at user and project scope is the same bytes either way.
 */
export function readInstalledPluginPaths(homeDir: string): Map<string, string> {
  const paths = new Map<string, string>()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path.join(homeDir, INSTALLED_PLUGINS_RELATIVE_PATH), 'utf8'))
  } catch {
    return paths
  }
  if (!isRecord(raw) || !isRecord(raw.plugins)) {
    return paths
  }
  for (const [key, value] of Object.entries(raw.plugins)) {
    if (!Array.isArray(value)) {
      continue
    }
    const record = value.find(
      (candidate) => isRecord(candidate) && typeof candidate.installPath === 'string'
    )
    if (isRecord(record) && typeof record.installPath === 'string' && record.installPath) {
      paths.set(key, record.installPath)
    }
  }
  return paths
}

/** What an unpacked plugin holds. An unreadable path is an empty shape, never a throw. */
export function readPluginShape(installPath: string | undefined): PluginShape {
  if (!installPath) {
    return EMPTY_SHAPE
  }
  let skills: string[] = []
  try {
    skills = readdirSync(path.join(installPath, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .slice(0, MAX_SKILLS)
      .map((entry) => entry.name)
      .sort()
  } catch {
    // No skills/ directory. Common enough to be unremarkable — MCP-only,
    // hooks-only and agents-only plugins all look like this.
  }
  let hasMcp = false
  try {
    hasMcp = existsSync(path.join(installPath, '.mcp.json'))
  } catch {
    // An unreadable path answers the same as an absent one.
  }
  return { skills, hasMcp }
}

/**
 * The installed shelf as the company context needs to describe it.
 *
 * Marketplace text for the name, BuildEx's overlay where it says it better, and
 * the plugin's own contents for what it can actually do.
 */
export function readInstalledPluginInventory(
  homeDir: string,
  entries: readonly StoreEntry[]
): InstalledAppSummary[] {
  const installPaths = readInstalledPluginPaths(homeDir)
  const summaries: InstalledAppSummary[] = []
  for (const entry of entries) {
    if (!entry.installed) {
      continue
    }
    const shape = readPluginShape(
      installPaths.get(installKey(entry.plugin.name, entry.marketplaceId))
    )
    const apiKey = entry.overlay?.apiKey
    summaries.push({
      id: entry.plugin.name,
      name: entry.plugin.displayName,
      summary: entry.overlay?.summary ?? entry.plugin.description,
      skills: shape.skills,
      hasMcp: shape.hasMcp,
      ...(apiKey
        ? {
            envKey: envKeyForPlugin(entry.plugin.name, apiKey),
            connected: entry.credentialConnected === true
          }
        : {})
    })
  }
  return summaries
}
