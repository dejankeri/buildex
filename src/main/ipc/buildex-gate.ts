import { ipcMain } from 'electron'
import type { GateSettingsRequest, GateSettingsResult } from '../../shared/buildex-gate-types'
import { DEFAULT_GATE_PRESET } from '../buildex-gate/gate-preset'
import { syncGateSettings } from '../buildex-gate/gate-settings'
import { installedPluginGateRules } from '../buildex-repo-init'

function emptyResult(error?: string): GateSettingsResult {
  return {
    preset: DEFAULT_GATE_PRESET,
    source: 'bundle',
    settingsChanged: false,
    preservedRules: [],
    error
  }
}

export function registerBuildExGateHandlers(): void {
  ipcMain.handle(
    'buildex-gate:sync',
    (_event, request?: GateSettingsRequest): GateSettingsResult => {
      const repoPath = request?.repoPath?.trim()
      if (!repoPath) {
        return emptyResult('Missing repoPath')
      }
      // Why the plugin rules: the Store page syncs on every mount and every
      // workspace switch, and a sync without them retires the ask rules the last
      // install wrote — the gate quietly narrows by being looked at.
      return syncGateSettings(repoPath, installedPluginGateRules(repoPath))
    }
  )
}
