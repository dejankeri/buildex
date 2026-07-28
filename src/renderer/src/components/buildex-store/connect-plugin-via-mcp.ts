import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/types'

// Signing a plugin in.
//
// Claude Code already owns OAuth for remote MCP servers: it runs the browser
// flow, stores the token, and refreshes it. BuildEx deliberately does not build
// a second credential store to compete with the one the agent already trusts —
// so "Connect" opens a session and runs the agent's own `/mcp` command.
//
// One click for the operator, no tokens in BuildEx's hands.

/** The command that opens the agent's MCP panel, where the sign-in lives. */
export const MCP_CONNECT_COMMAND = '/mcp'

// Why: `/mcp` is Claude Code's command. Offering the button for an agent that
// does not understand it would open a terminal and type nonsense.
const AGENTS_WITH_MCP_COMMAND: TuiAgent[] = ['claude']

export function resolveMcpConnectAgent(
  detectedIds: TuiAgent[] | null,
  defaultAgent: TuiAgent | 'blank' | null | undefined
): TuiAgent | null {
  if (!detectedIds) {
    return null
  }
  const candidates = AGENTS_WITH_MCP_COMMAND.filter((agent) => detectedIds.includes(agent))
  if (candidates.length === 0) {
    return null
  }
  if (defaultAgent && defaultAgent !== 'blank' && candidates.includes(defaultAgent)) {
    return defaultAgent
  }
  return candidates[0]
}

export function launchMcpConnect(args: {
  agent: TuiAgent
  worktreeId: string
}): { tabId: string | null } | null {
  const result = launchAgentInNewTab({
    agent: args.agent,
    worktreeId: args.worktreeId,
    // Why: the same default the rest of the app uses — a pane of its own for
    // this worktree rather than joining an unrelated group.
    groupId: args.worktreeId,
    prompt: MCP_CONNECT_COMMAND,
    // Why: a slash command has to reach a live session, not a still-booting one.
    promptDelivery: 'submit-after-ready'
    // launchSource is deliberately omitted: it is a closed telemetry enum, and
    // adding a BuildEx value would mean editing an upstream schema.
  })
  if (!result) {
    return null
  }
  // Why: worktree activation is what normally returns the app to the terminal
  // view, and it does not run here — the worktree is already active. Without
  // this the session starts behind the Store and the operator sees nothing
  // happen but a new row in the sidebar.
  const store = useAppStore.getState()
  if (store.activeView !== 'terminal') {
    store.setActiveView('terminal')
  }
  if (result.tabId) {
    store.setActiveTab?.(result.tabId)
  }
  return { tabId: result.tabId ?? null }
}
