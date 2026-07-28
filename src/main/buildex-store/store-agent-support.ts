import type { AgentType } from '../../shared/agent-status-types'

// Which agents BuildEx can install a plugin for.
//
// Every major agent now has a plugin system — Claude Code's marketplaces, Codex
// since 0.117.0, Cursor 2.5, and Gemini CLI's extensions — and vendors publish
// one repo with a manifest for each. BuildEx drives Claude Code's today; the
// rest are additions to this map rather than changes to anything above it.
//
// An unsupported agent is named rather than silently ignored: the Store still
// browses, and says which agent the workspace runs and why nothing installs.

const SUPPORTED_AGENTS = new Set<string>(['claude'])

export function supportsPluginInstall(agent: AgentType | undefined | null): boolean {
  return Boolean(agent) && SUPPORTED_AGENTS.has(String(agent))
}

/**
 * The agent to report as unsupported, or null when installing will work.
 *
 * An absent agent reads as supported: a workspace that has not picked one yet
 * should not be told the Store is broken.
 */
export function unsupportedInstallAgent(agent: AgentType | undefined | null): string | null {
  if (!agent || supportsPluginInstall(agent)) {
    return null
  }
  return String(agent)
}
