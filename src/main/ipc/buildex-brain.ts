import { ipcMain } from 'electron'
import type {
  AgentView,
  AgentViewRequest,
  BrainCloneRequest,
  BrainCloneResult,
  BrainMigrateRequest,
  BrainMigrationResult,
  BrainPullRequest,
  BrainPullResult,
  BrainRemovalPlan,
  BrainRemovalRequest,
  BrainRemovalResult,
  BrainResolveRequest,
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
import { cloneBrain } from '../buildex-brain/brain-clone'
import { migrateBrainToExternal } from '../buildex-brain/brain-migrate'
import { disconnectBrain, planBrainRemoval, removeBrain } from '../buildex-brain/brain-remove'
import { createBrainDocument } from '../buildex-brain/brain-document-create'
import {
  embeddedLocation,
  externalLocation,
  requireBrainLocation,
  resolveBrainLocation
} from '../buildex-brain/brain-location'
import { readBrainHistory, saveBrain } from '../buildex-brain/brain-history'
import { pullBrain } from '../buildex-brain/brain-sync'
import { createBrainSkill, listBrainSkills } from '../buildex-brain/brain-skills'
import { refreshCompanyContext } from '../buildex-brain/company-context-refresh'
import { bundledCatalogRoot, initializeCompanyRepo } from '../buildex-repo-init'

// Reachable when repoPath resolved but the brain itself did not — a pointer
// naming an unfetched remote, or a binding whose path is gone. Distinct from a
// truly missing repoPath, which each handler checks first.
const BRAIN_UNRESOLVED = "This repo's brain could not be resolved"

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
        return { ok: false, error: BRAIN_UNRESOLVED }
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
        return { ok: false, savedPaths: [], error: BRAIN_UNRESOLVED }
      }
      return saveBrain(location, request?.message ?? '')
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
        return { ok: false, error: BRAIN_UNRESOLVED }
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
      const resolution = resolveBrainLocation(repoPath)
      if (resolution.status !== 'ready') {
        return { ...EMPTY_BRAIN_SCAN, repoPath, resolution }
      }
      const { location } = resolution
      const scan = await scanCompanyBrain(repoPath, location, resolution, Date.now())
      // Why: opening the Brain is the moment to catch up on anything that changed
      // outside the app — a document pulled from a teammate, a file written by
      // the agent itself. Neither is awaited: the screen renders from local
      // state now and picks both up on the next refresh.
      void pullBrain(location)
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
      return { ok: false, created: [], error: BRAIN_UNRESOLVED }
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
      if (!repoPath) {
        return { ok: false, committed: false, error: 'Missing repoPath' }
      }
      const location = requireBrainLocation(repoPath)
      if (!location) {
        return { ok: false, committed: false, error: BRAIN_UNRESOLVED }
      }
      // External brains are shared across repos, so this deletes nothing for
      // one: removeBrain refuses any mode but embedded on its own. Detaching
      // from an external brain is `buildex-brain:disconnect`'s job, not this
      // one's — no mode dispatch here.
      const result = await removeBrain(repoPath, location, Date.now())
      if (result.ok) {
        // The agent's context still names every document that was just removed.
        void refreshCompanyContext(repoPath, location, { bundledCatalogRoot: bundledCatalogRoot() })
      }
      return result
    }
  )

  ipcMain.handle(
    'buildex-brain:resolve',
    (_event, request?: BrainResolveRequest): BrainResolution | null => {
      const repoPath = request?.repoPath?.trim()
      return repoPath ? resolveBrainLocation(repoPath) : null
    }
  )

  ipcMain.handle(
    'buildex-brain:clone',
    async (_event, request?: BrainCloneRequest): Promise<BrainCloneResult> => {
      const repoPath = request?.repoPath?.trim()
      const remote = request?.remote?.trim()
      const targetPath = request?.targetPath?.trim()
      if (!repoPath || !remote || !targetPath) {
        return { ok: false, error: 'Missing repoPath, remote or targetPath' }
      }
      const result = await cloneBrain(remote, targetPath)
      if (result.ok) {
        const location = requireBrainLocation(repoPath) ?? externalLocation(targetPath, remote)
        void refreshCompanyContext(repoPath, location, { bundledCatalogRoot: bundledCatalogRoot() })
      }
      return result
    }
  )

  ipcMain.handle(
    'buildex-brain:migrate',
    async (_event, request?: BrainMigrateRequest): Promise<BrainMigrationResult> => {
      const repoPath = request?.repoPath?.trim()
      const brainPath = request?.brainPath?.trim()
      if (!repoPath || !brainPath) {
        return { ok: false, movedPaths: [], error: 'Missing repoPath or brainPath' }
      }
      const result = await migrateBrainToExternal(
        {
          repoPath,
          brainPath,
          ...(request?.remote ? { remote: request.remote } : {}),
          writePointer: Boolean(request?.writePointer)
        },
        Date.now()
      )
      if (result.ok) {
        // The brain just left the repo entirely, so resolve fresh rather than
        // reuse a location the migration just invalidated.
        const location =
          requireBrainLocation(repoPath) ?? externalLocation(brainPath, request?.remote)
        void refreshCompanyContext(repoPath, location, { bundledCatalogRoot: bundledCatalogRoot() })
      }
      return result
    }
  )

  ipcMain.handle(
    'buildex-brain:disconnect',
    (_event, request?: BrainRemovalRequest): BrainRemovalResult => {
      const repoPath = request?.repoPath?.trim()
      if (!repoPath) {
        return { ok: false, committed: false, error: 'Missing repoPath' }
      }
      const result = disconnectBrain(repoPath)
      if (result.ok) {
        // Disconnecting changes what this repo's brain even is, so resolve
        // again rather than reuse the location disconnect just invalidated.
        const location = requireBrainLocation(repoPath) ?? embeddedLocation(repoPath)
        void refreshCompanyContext(repoPath, location, { bundledCatalogRoot: bundledCatalogRoot() })
      }
      return result
    }
  )

  ipcMain.handle(
    'buildex-brain:pull',
    async (_event, request?: BrainPullRequest): Promise<BrainPullResult> => {
      const repoPath = request?.repoPath?.trim()
      const location = repoPath ? requireBrainLocation(repoPath) : null
      if (!location) {
        return { pulled: false, diverged: false }
      }
      return pullBrain(location)
    }
  )
}
