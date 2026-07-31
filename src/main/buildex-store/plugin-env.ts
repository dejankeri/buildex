import type { StoreEntry } from '../../shared/buildex-store-types'
import {
  envKeyForPlugin,
  readPluginCredential,
  type PluginCredentialDeps
} from './plugin-credentials'

// Put installed plugins' keys into the agent's environment.
//
// This is the one moment a key is in the clear, and it is the moment it has to
// be: a plugin's own .mcp.json references ${VAR}, and the skills of `rest`
// plugins read the same variable. Everything either side of this — storage, the
// repo, git — stays free of it.
//
// Only installed plugins contribute. A key saved for a plugin the operator
// later removed must not keep reaching the agent.
//
// Which company's keys is decided by `deps.companyKey` — the caller resolves it
// from the workspace, because knowing what a business is is not this module's
// job and threading a repo path down here would make it one.

export function collectPluginEnv(
  deps: PluginCredentialDeps,
  entries: readonly StoreEntry[]
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of entries) {
    const apiKey = entry.overlay?.apiKey
    if (!entry.installed || !apiKey) {
      continue
    }
    const value = readPluginCredential(deps, entry.plugin.name)
    if (!value) {
      continue
    }
    const envKey = envKeyForPlugin(entry.plugin.name, apiKey)
    env[envKey] = value
    // Why: a key is paired with its API base (PROTOCOL_API_KEY with
    // PROTOCOL_API_URL), and skills read both.
    if (apiKey.apiBase) {
      env[`${envKey.replace(/_API_KEY$/, '')}_API_URL`] = apiKey.apiBase
    }
  }
  return env
}

/** The ask/deny rules every installed, curated plugin contributes to the gate. */
export function collectPluginGateRules(entries: readonly StoreEntry[]): {
  ask: string[]
  deny: string[]
} {
  const ask = new Set<string>()
  const deny = new Set<string>()
  for (const entry of entries) {
    if (!entry.installed || !entry.overlay?.gate) {
      continue
    }
    for (const rule of entry.overlay.gate.ask ?? []) {
      ask.add(rule)
    }
    for (const rule of entry.overlay.gate.deny ?? []) {
      deny.add(rule)
    }
  }
  return { ask: [...ask].sort(), deny: [...deny].sort() }
}
