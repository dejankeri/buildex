import { ipcMain } from 'electron'
import type {
  AgentView,
  AgentViewRequest,
  BrainRemovalPlan,
  BrainRemovalRequest,
  BrainRemovalResult,
  BrainSetupRequest,
  BrainSetupResult,
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
  BrainScanRequest,
  BrainResolution
} from '../../shared/buildex-brain-types'
import { EMPTY_AGENT_VIEW, EMPTY_BRAIN_SCAN } from '../../shared/buildex-brain-types'
import { scanCompanyBrain } from '../buildex-brain/company-brain-service'
import { BRAIN_SECTIONS, scaffoldCompanyBrain } from '../buildex-brain/brain-scaffold'
import { buildAgentView } from '../buildex-brain/agent-view'
import { disconnectBrain, planBrainRemoval, removeBrain } from '../buildex-brain/brain-remove'
import { createBrainDocument } from '../buildex-brain/brain-document-create'
import { embeddedLocation, requireBrainLocation } from '../buildex-brain/brain-location'
import { commitBrain, readBrainHistory } from '../buildex-brain/brain-history'
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
      const location = repoPath ? requireBrainLocation(repoPath) : null
      return { skills: repoPath && location ? listBrainSkills(repoPath, location) : [] }
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
      const location = requireBrainLocation(repoPath)
      if (!location) {
        return { ok: false, error: 'Missing repoPath or title' }
      }
      return createBrainSkill(repoPath, location, title)
    }
  )

  ipcMain.handle(
    'buildex-brain:history',
    async (_event, request?: BrainHistoryRequest): Promise<BrainHistoryResult> => {
      const repoPath = request?.repoPath?.trim()
      const location = repoPath ? requireBrainLocation(repoPath) : null
      if (!location) {
        return { saves: [], unavailable: true, unsavedPaths: [] }
      }
      return readBrainHistory(location, request?.limit)
    }
  )

  // Why: this is the one BuildEx action that writes company history. It is
  // scoped to the brain's own pathspec end to end — see brain-history.ts.
  ipcMain.handle(
    'buildex-brain:save',
    async (_event, request?: BrainSaveRequest): Promise<BrainSaveResult> => {
      const repoPath = request?.repoPath?.trim()
      const location = repoPath ? requireBrainLocation(repoPath) : null
      if (!location) {
        return { ok: false, savedPaths: [], error: 'Missing repoPath' }
      }
      return commitBrain(location, request?.message ?? '')
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
      const location = requireBrainLocation(repoPath)
      if (!location) {
        return { ok: false, error: 'Missing repoPath or title' }
      }
      const result = createBrainDocument(location, request?.folder ?? '', title)
      if (result.ok) {
        // Why: a new document the agent does not know about is the most common
        // way the context goes stale. Not awaited — the operator is waiting to
        // start writing, not for bookkeeping.
        void refreshCompanyContext(repoPath, location, { bundledCatalogRoot: bundledCatalogRoot() })
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
      const location = requireBrainLocation(repoPath)
      if (!location) {
        return EMPTY_BRAIN_SCAN
      }
      const resolution: BrainResolution = { status: 'ready', location }
      const scan = await scanCompanyBrain(repoPath, location, resolution, Date.now())
      // Why: opening the Brain is the moment to catch up on anything that changed
      // outside the app — a document pulled from a teammate, a file written by
      // the agent itself. Not awaited: the screen should not wait for it.
      void refreshCompanyContext(repoPath, location, { bundledCatalogRoot: bundledCatalogRoot() })
      return scan
    }
  )

  // Why: the one place the brain's sections get written, and it runs only when
  // the operator has chosen them. See buildex-repo-init.ts for what BuildEx
  // still does on its own — machine state, never company files.
  ipcMain.handle('buildex-brain:setup', (_event, request?: BrainSetupRequest): BrainSetupResult => {
    const repoPath = request?.repoPath?.trim()
    const folders = request?.folders ?? []
    if (!repoPath) {
      return { ok: false, created: [], error: 'Missing repoPath' }
    }
    if (folders.length === 0) {
      return { ok: false, created: [], error: 'Choose at least one section' }
    }
    const location = requireBrainLocation(repoPath)
    if (!location) {
      return { ok: false, created: [], error: 'Missing repoPath' }
    }
    try {
      const result = scaffoldCompanyBrain(location, { folders, summary: request?.summary })
      void refreshCompanyContext(repoPath, location, { bundledCatalogRoot: bundledCatalogRoot() })
      return { ok: true, created: result.created }
    } catch (error) {
      return {
        ok: false,
        created: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle(
    'buildex-brain:agentView',
    async (_event, request?: AgentViewRequest): Promise<AgentView> => {
      const repoPath = request?.repoPath?.trim()
      if (!repoPath) {
        return EMPTY_AGENT_VIEW
      }
      const location = requireBrainLocation(repoPath)
      if (!location) {
        return EMPTY_AGENT_VIEW
      }
      // Why: the context file is rewritten first, so the dialog shows what the
      // next session will actually get rather than what the last one got.
      await refreshCompanyContext(repoPath, location, { bundledCatalogRoot: bundledCatalogRoot() })
      const resolution: BrainResolution = { status: 'ready', location }
      const scan = await scanCompanyBrain(repoPath, location, resolution, Date.now())
      return buildAgentView(repoPath, scan)
    }
  )

  ipcMain.handle(
    'buildex-brain:removalPlan',
    async (_event, request?: BrainRemovalRequest): Promise<BrainRemovalPlan> => {
      const repoPath = request?.repoPath?.trim()
      const location = repoPath ? requireBrainLocation(repoPath) : null
      if (!location) {
        return { documentCount: 0, unsavedPaths: [], canCommit: false, willBackUp: false }
      }
      return planBrainRemoval(location)
    }
  )

  ipcMain.handle(
    'buildex-brain:remove',
    async (_event, request?: BrainRemovalRequest): Promise<BrainRemovalResult> => {
      const repoPath = request?.repoPath?.trim()
      const location = repoPath ? requireBrainLocation(repoPath) : null
      if (!repoPath || !location) {
        return { ok: false, committed: false, error: 'Missing repoPath' }
      }
      // External brains are shared across repos, so this button may only ever
      // disconnect from one, never delete it. Task 12 gives disconnect its own
      // channel; until then, mode decides here.
      const result =
        location.mode === 'external'
          ? disconnectBrain(repoPath)
          : await removeBrain(repoPath, location, Date.now())
      if (result.ok) {
        // The agent's context still names every document that was just removed.
        // Disconnecting an external brain changes what this repo's brain even
        // is, so resolve again rather than reuse the location removal just
        // invalidated.
        const refreshedLocation = requireBrainLocation(repoPath) ?? embeddedLocation(repoPath)
        void refreshCompanyContext(repoPath, refreshedLocation, {
          bundledCatalogRoot: bundledCatalogRoot()
        })
      }
      return result
    }
  )
}
