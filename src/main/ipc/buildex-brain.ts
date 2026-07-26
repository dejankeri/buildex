import { ipcMain } from 'electron'
import type {
  BrainScan,
  BrainScanRequest,
  ContextSyncRequest,
  ContextSyncResponse
} from '../../shared/buildex-brain-types'
import { EMPTY_BRAIN_SCAN } from '../../shared/buildex-brain-types'
import { scanCompanyBrain } from '../buildex-brain/company-brain-service'
import { syncCompanyContext } from '../buildex-brain/company-context'

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

  ipcMain.handle(
    'buildex-brain:syncContext',
    async (_event, request?: ContextSyncRequest): Promise<ContextSyncResponse> => {
      const repoPath = request?.repoPath?.trim()
      if (!repoPath) {
        return {
          ok: false,
          contextPath: '',
          contextChanged: false,
          claudeMdChanged: false,
          error: 'Missing repoPath'
        }
      }
      try {
        const scan = await scanCompanyBrain(repoPath, Date.now())
        const result = syncCompanyContext(repoPath, scan)
        return { ok: true, ...result }
      } catch (error) {
        return {
          ok: false,
          contextPath: '',
          contextChanged: false,
          claudeMdChanged: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
}
