import { existsSync } from 'node:fs'
import { ipcMain } from 'electron'
import type {
  AgentView,
  AgentViewRequest,
  BrainCreateDocumentRequest,
  BrainCreateDocumentResult,
  BrainCreateEntityRequest,
  BrainCreateEntityResult,
  BrainHistoryRequest,
  BrainHistoryResult,
  BrainResolution,
  BrainSaveDiffRequest,
  BrainSaveDiffResult,
  BrainSaveRequest,
  BrainSaveResult,
  BrainScan,
  BrainScanRequest,
  BrainSectionsResult,
  BrainSetupRequest,
  BrainSetupResult,
  BrainSkillCreateRequest,
  BrainSkillCreateResult,
  BrainSkillsRequest,
  BrainSkillsResult
} from '../../shared/buildex-brain-types'
import { EMPTY_AGENT_VIEW, EMPTY_BRAIN_SCAN } from '../../shared/buildex-brain-types'
import { scanCompanyBrain } from '../buildex-brain/company-brain-service'
import { BRAIN_SECTIONS, scaffoldCompanyBrain } from '../buildex-brain/brain-scaffold'
import { buildAgentView } from '../buildex-brain/agent-view'
import { createBrainDocument } from '../buildex-brain/brain-document-create'
import { createBrainEntity } from '../buildex-brain/brain-entity-create'
import { embeddedBrainCheckout, embeddedLocation } from '../buildex-brain/brain-location'
import {
  checkoutCommitBlockMessage,
  readCheckoutCommitBlock
} from '../buildex-brain/checkout-commit-block'
import { requireBrainLocation, resolveBrainLocation } from './authorized-brain-location'
import { readBrainHistory, saveBrain } from '../buildex-brain/brain-history'
import { readBrainSaveDiff } from '../buildex-brain/brain-save-diff'
import { createBrainSkill, listBrainSkills } from '../buildex-brain/brain-skills'
import { relinkBrainSkills } from '../buildex-brain/skill-link'
import { refreshCompanyContext } from '../buildex-brain/company-context-refresh'
import { initializeCompanyRepo } from '../buildex-repo-init'
import { readInstalledAppSummaries } from '../buildex-store/store-catalog-source'
import { registerBuildExBrainPlacementHandlers } from './buildex-brain-placement'

// Reading and rendering the brain — what's in it, not where it is. Where a
// repo's brain lives, and changing that, is buildex-brain-placement.ts;
// registered from here so callers still reach the whole surface through one
// entry point.
//
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

  // Why: what a save changed, not what the documents say now. Agents write to
  // the brain on scheduled runs, and reviewing that means reading the diff.
  ipcMain.handle(
    'buildex-brain:saveDiff',
    async (_event, request?: BrainSaveDiffRequest): Promise<BrainSaveDiffResult> => {
      const repoPath = request?.repoPath?.trim()
      const hash = request?.hash?.trim()
      const location = repoPath ? requireBrainLocation(repoPath) : null
      if (!location || !hash) {
        return { files: [], truncated: false, unavailable: true, linesUnavailable: false }
      }
      return readBrainSaveDiff(location, hash)
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
      // Checked before the save runs, not left to git: `git add` would succeed
      // and the partial commit behind it would fail, leaving the brain staged in
      // a conflicted index the operator is about to commit.
      const blocking = await readCheckoutCommitBlock(location.gitRoot)
      if (blocking) {
        return {
          ok: false,
          savedPaths: [],
          error: checkoutCommitBlockMessage(blocking, location.gitRoot)
        }
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
        void refreshCompanyContext(
          repoPath,
          location,
          readInstalledAppSummaries(location, repoPath)
        )
      }
      return result
    }
  )

  // Why: an entity is a folder plus the main file that marks it. Making one by
  // hand means knowing that convention; this is what means nobody has to.
  ipcMain.handle(
    'buildex-brain:createEntity',
    (_event, request?: BrainCreateEntityRequest): BrainCreateEntityResult => {
      const repoPath = request?.repoPath?.trim()
      const title = request?.title?.trim()
      if (!repoPath || !title) {
        return { ok: false, error: 'Missing repoPath or title' }
      }
      const location = requireBrainLocation(repoPath)
      if (!location) {
        return { ok: false, error: BRAIN_UNRESOLVED }
      }
      const result = createBrainEntity(location, request?.parentFolder ?? '', title)
      if (result.ok) {
        void refreshCompanyContext(
          repoPath,
          location,
          readInstalledAppSummaries(location, repoPath)
        )
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
      //
      // Skipped for a read-only scan. A surface that reads N companies at once
      // — the Portfolio — would otherwise gate, relink and rewrite the context
      // of every business the operator merely glanced at, and repeat it on
      // every refresh. Preparing a checkout belongs to opening it.
      const readOnly = request?.readOnly === true
      if (!readOnly) {
        initializeCompanyRepo(repoPath)
      }
      const resolution = resolveBrainLocation(repoPath)
      if (resolution.status !== 'ready') {
        // Why: independent of how the brain currently resolves — the renderer
        // cannot stat the filesystem itself, and needs to know whether there is
        // an embedded brain worth moving before it can choose migrate over bind.
        return {
          ...EMPTY_BRAIN_SCAN,
          repoPath,
          resolution,
          embeddedBrainPresent: existsSync(embeddedLocation(embeddedBrainCheckout(repoPath)).root)
        }
      }
      const { location } = resolution
      // Why: heals a checkout whose `.claude/skills/` links were never built —
      // every worktree created before this ran, and any the operator made by
      // hand. Idempotent: an existing link is recognised, not rewritten.
      if (!readOnly) {
        relinkBrainSkills(repoPath, location)
      }
      const scan = await scanCompanyBrain(repoPath, location, resolution, Date.now())
      // Why: opening the Brain is the moment to catch up on anything the agent
      // itself wrote. Not awaited — the screen renders from local state now.
      // The brain's own fetch is `buildex-brain:pull`, which the Brain page
      // calls on open: its answer includes whether the brain has diverged, and
      // there is nowhere to report that from here.
      if (!readOnly) {
        void refreshCompanyContext(
          repoPath,
          location,
          readInstalledAppSummaries(location, repoPath)
        )
      }
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
      void refreshCompanyContext(repoPath, location, readInstalledAppSummaries(location, repoPath))
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
      await refreshCompanyContext(repoPath, location, readInstalledAppSummaries(location, repoPath))
      const resolution: BrainResolution = { status: 'ready', location }
      const scan = await scanCompanyBrain(repoPath, location, resolution, Date.now())
      return buildAgentView(repoPath, scan)
    }
  )

  registerBuildExBrainPlacementHandlers()
}
