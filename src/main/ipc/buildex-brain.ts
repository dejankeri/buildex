import { ipcMain } from 'electron'
import type { BrainScan, BrainScanRequest } from '../../shared/buildex-brain-types'
import { EMPTY_BRAIN_SCAN } from '../../shared/buildex-brain-types'
import { scanCompanyBrain } from '../buildex-brain/company-brain-service'

export function registerBuildExBrainHandlers(): void {
  ipcMain.handle(
    'buildex-brain:scan',
    async (_event, request?: BrainScanRequest): Promise<BrainScan> => {
      const repoPath = request?.repoPath?.trim()
      if (!repoPath) {
        return EMPTY_BRAIN_SCAN
      }
      return scanCompanyBrain(repoPath, Date.now())
    }
  )
}
