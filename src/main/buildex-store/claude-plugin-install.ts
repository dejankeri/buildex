import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { StoreInstallResult } from '../../shared/buildex-store-types'

// Installing through Claude Code's own plugin CLI.
//
// BuildEx does not unpack plugins itself. Half of the marketplace carries
// commands, hooks, subagents or an LSP server, and a quarter of it has no
// skills at all — copying the skills-shaped part of a plugin would produce a
// partial install for most of the shelf and an empty one for the rest. The CLI
// installs a plugin whole, and updates it later without us.
//
// Scope is `user`: a plugin is installed by the person who wants it, on the
// machine they want it on, which is what makes the Store per-operator rather
// than something a repo imposes on everyone who clones it.

export const INSTALLED_PLUGINS_RELATIVE_PATH = path.join(
  '.claude',
  'plugins',
  'installed_plugins.json'
)

export type PluginCommandResult = { ok: boolean; output: string }

export type ClaudePluginDeps = {
  homeDir: string
  /** Runs `claude <args>`. Injected so the driver is testable without the CLI. */
  run: (args: string[]) => PluginCommandResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * What the agent reports as installed, keyed `plugin@marketplace`.
 *
 * Read from the agent's own state rather than tracked by BuildEx: the operator
 * can install and remove plugins from inside Claude Code, and a second record of
 * ours would start disagreeing with it the first time they did.
 */
export function readInstalledPlugins(homeDir: string): Set<string> {
  const installed = new Set<string>()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path.join(homeDir, INSTALLED_PLUGINS_RELATIVE_PATH), 'utf8'))
  } catch {
    // No file means nothing installed, which is the honest answer on a machine
    // where the operator has never installed a plugin.
    return installed
  }
  if (!isRecord(raw) || !isRecord(raw.plugins)) {
    return installed
  }
  for (const [key, value] of Object.entries(raw.plugins)) {
    // An entry is a list of installs across scopes; an empty list means the
    // plugin was removed and its key left behind.
    if (Array.isArray(value) && value.length > 0) {
      installed.add(key)
    }
  }
  return installed
}

/** `plugin@marketplace`, the id the CLI installs and uninstalls by. */
export function pluginRef(pluginName: string, marketplaceId: string): string {
  return `${pluginName}@${marketplaceId}`
}

/**
 * Adding a marketplace twice is not an error worth surfacing.
 *
 * The CLI fails when the marketplace is already configured, and it is configured
 * for every plugin after the first — so treating that as a failure would make
 * the second install from a marketplace always look broken.
 */
function alreadyConfigured(output: string): boolean {
  return /already (exists|added|configured)|duplicate/i.test(output)
}

function ensureMarketplace(deps: ClaudePluginDeps, repo: string): PluginCommandResult {
  const result = deps.run(['plugin', 'marketplace', 'add', repo])
  if (result.ok || alreadyConfigured(result.output)) {
    return { ok: true, output: result.output }
  }
  return result
}

export type PluginInstallTarget = {
  pluginName: string
  marketplaceId: string
  /** `owner/repo` or a URL, as the CLI's `marketplace add` takes it. */
  marketplaceRepo: string
}

/** Install one plugin, adding its marketplace first if this machine lacks it. */
export function installClaudePlugin(
  deps: ClaudePluginDeps,
  target: PluginInstallTarget
): StoreInstallResult {
  const configured = ensureMarketplace(deps, target.marketplaceRepo)
  if (!configured.ok) {
    return {
      ok: false,
      output: configured.output,
      error: `Could not add the marketplace ${target.marketplaceRepo}`
    }
  }
  const result = deps.run([
    'plugin',
    'install',
    pluginRef(target.pluginName, target.marketplaceId),
    '--scope',
    'user'
  ])
  return result.ok
    ? { ok: true, output: result.output }
    : { ok: false, output: result.output, error: `Could not install ${target.pluginName}` }
}

export function uninstallClaudePlugin(
  deps: ClaudePluginDeps,
  target: Pick<PluginInstallTarget, 'pluginName' | 'marketplaceId'>
): StoreInstallResult {
  const result = deps.run([
    'plugin',
    'uninstall',
    pluginRef(target.pluginName, target.marketplaceId)
  ])
  return result.ok
    ? { ok: true, output: result.output }
    : { ok: false, output: result.output, error: `Could not remove ${target.pluginName}` }
}
