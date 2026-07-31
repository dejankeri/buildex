import type { Automation } from './automations-types'

/**
 * Which workspace an automation run is about to start its agent in.
 *
 * The mode travels with the id because it decides whether there is anything to
 * do: a `new_per_run` workspace was prepared as it was created.
 */
export type AutomationWorkspaceContextRequest = Pick<Automation, 'workspaceMode' | 'workspaceId'>
