import type { Automation } from '../../../shared/automations-types'

/**
 * The company's context, refreshed before an automation's agent reads `.claude/`.
 *
 * The renderer only asks. The scan, its 10-second deadline and the rule that a
 * remote workspace is never written to locally all live in the main process, so
 * this dispatch path and the headless one cannot answer differently.
 *
 * Awaited, because Claude Code reads `.claude/` once at session start — a refresh
 * still in flight when the agent spawns reaches nobody. Never rejects: a run that
 * did not happen is strictly worse than a run with stale context.
 */
export async function prepareAutomationWorkspaceContext(
  automation: Pick<Automation, 'workspaceMode'>,
  workspaceId: string
): Promise<void> {
  try {
    await window.api.buildexAutomationContext.prepareWorkspace({
      workspaceMode: automation.workspaceMode,
      workspaceId
    })
  } catch (error) {
    console.warn(`[buildex] company context for ${workspaceId} was not refreshed:`, error)
  }
}
