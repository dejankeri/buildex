import { ipcMain } from 'electron'
import type { GateSettingsRequest, GateSettingsResult } from '../../shared/buildex-gate-types'
import { DEFAULT_GATE_PRESET } from '../buildex-gate/gate-preset'
import { syncGateSettings } from '../buildex-gate/gate-settings'

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
      return syncGateSettings(repoPath)
    }
  )
}
