import { ipcMain } from 'electron'
import type {
  BrainSkillsRequest,
  BrainSkillsResult,
  BrainSkillCreateRequest,
  BrainSkillCreateResult,
  BrainHistoryRequest,
  BrainHistoryResult,
  BrainSaveRequest,
  BrainSaveResult,
  BrainCreateDocumentRequest,
  BrainCreateDocumentResult,
  BrainSectionsResult,
  BrainScan,
  BrainScanRequest
} from '../../shared/buildex-brain-types'
import { EMPTY_BRAIN_SCAN } from '../../shared/buildex-brain-types'
import { scanCompanyBrain } from '../buildex-brain/company-brain-service'
import { BRAIN_SECTIONS } from '../buildex-brain/brain-scaffold'
import { createBrainDocument } from '../buildex-brain/brain-document-create'
import { readBrainHistory, saveBrain } from '../buildex-brain/brain-history'
import { createBrainSkill, listBrainSkills } from '../buildex-brain/brain-skills'
import { refreshCompanyContext } from '../buildex-brain/company-context-refresh'
import { bundledCatalogRoot, initializeCompanyRepo } from '../buildex-repo-init'

export function registerBuildExBrainHandlers(): void {
  ipcMain.handle(
    'buildex-brain:sections',
    (): BrainSectionsResult => ({
      sections: BRAIN_SECTIONS.map(({ folder, title, purpose }) => ({ folder, title, purpose }))
    })
  )

  ipcMain.handle(
    'buildex-brain:skills',
    (_event, request?: BrainSkillsRequest): BrainSkillsResult => {
      const repoPath = request?.repoPath?.trim()
      return { skills: repoPath ? listBrainSkills(repoPath) : [] }
    }
  )

  ipcMain.handle(
    'buildex-brain:createSkill',
    (_event, request?: BrainSkillCreateRequest): BrainSkillCreateResult => {
      const repoPath = request?.repoPath?.trim()
      const title = request?.title?.trim()
      if (!repoPath || !title) {
        return { ok: false, error: 'Missing repoPath or title' }
      }
      return createBrainSkill(repoPath, title)
    }
  )

  ipcMain.handle(
    'buildex-brain:history',
    async (_event, request?: BrainHistoryRequest): Promise<BrainHistoryResult> => {
      const repoPath = request?.repoPath?.trim()
      if (!repoPath) {
        return { saves: [], unavailable: true, unsavedPaths: [] }
      }
      return readBrainHistory(repoPath, request?.limit)
    }
  )

  // Why: this is the one BuildEx action that writes company history. It is
  // scoped to `.buildex/` end to end — see brain-history.ts.
  ipcMain.handle(
    'buildex-brain:save',
    async (_event, request?: BrainSaveRequest): Promise<BrainSaveResult> => {
      const repoPath = request?.repoPath?.trim()
      if (!repoPath) {
        return { ok: false, savedPaths: [], error: 'Missing repoPath' }
      }
      return saveBrain(repoPath, request?.message ?? '')
    }
  )

  ipcMain.handle(
    'buildex-brain:createDocument',
    (_event, request?: BrainCreateDocumentRequest): BrainCreateDocumentResult => {
      const repoPath = request?.repoPath?.trim()
      const title = request?.title?.trim()
      if (!repoPath || !title) {
        return { ok: false, error: 'Missing repoPath or title' }
      }
      const result = createBrainDocument(repoPath, request?.folder ?? '', title)
      if (result.ok) {
        // Why: a new document the agent does not know about is the most common
        // way the context goes stale. Not awaited — the operator is waiting to
        // start writing, not for bookkeeping.
        void refreshCompanyContext(repoPath, { bundledCatalogRoot: bundledCatalogRoot() })
      }
      return result
    }
  )

  ipcMain.handle(
    'buildex-brain:scan',
    async (_event, request?: BrainScanRequest): Promise<BrainScan> => {
      const repoPath = request?.repoPath?.trim()
      if (!repoPath) {
        return EMPTY_BRAIN_SCAN
      }
      // Why: the Brain is often the first BuildEx surface a run opens, so this is
      // the earliest reliable moment to put the gate and the packs in order.
      initializeCompanyRepo(repoPath)
      const scan = await scanCompanyBrain(repoPath, Date.now())
      // Why: opening the Brain is the moment to catch up on anything that changed
      // outside the app — a document pulled from a teammate, a file written by
      // the agent itself. Not awaited: the screen should not wait for it.
      void refreshCompanyContext(repoPath, { bundledCatalogRoot: bundledCatalogRoot() })
      return scan
    }
  )
}
