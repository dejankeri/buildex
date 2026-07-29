import { ipcMain } from 'electron'
import type {
  BrainBindRequest,
  BrainBindResult,
  BrainCloneRequest,
  BrainCloneResult,
  BrainMigrateRequest,
  BrainMigrationResult,
  BrainPullRequest,
  BrainPullResult,
  BrainPushRequest,
  BrainPushResult,
  BrainRemovalPlan,
  BrainRemovalRequest,
  BrainRemovalResult,
  BrainResolution,
  BrainResolveRequest
} from '../../shared/buildex-brain-types'
import { cloneBrain } from '../buildex-brain/brain-clone'
import { migrateBrainToExternal } from '../buildex-brain/brain-migrate'
import { disconnectBrain, planBrainRemoval, removeBrain } from '../buildex-brain/brain-remove'
import {
  bindExistingBrain,
  embeddedLocation,
  externalLocation
} from '../buildex-brain/brain-location'
import {
  authorizeBrainLocation,
  requireBrainLocation,
  resolveBrainLocation
} from './authorized-brain-location'
import { pullBrain, pushBrain, reportPush } from '../buildex-brain/brain-sync'
import { refreshCompanyContext } from '../buildex-brain/company-context-refresh'
import { readInstalledAppSummaries } from '../buildex-store/store-catalog-source'

// Where a repo's brain lives, and changing that — split out of buildex-brain.ts
// (which renders the brain's content) once it grew past the point one file
// should hold both. Every handler here answers "where", never "what's in it".

const BRAIN_UNRESOLVED = "This repo's brain could not be resolved"

export function registerBuildExBrainPlacementHandlers(): void {
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
        void refreshCompanyContext(repoPath, location, readInstalledAppSummaries())
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
      const result = await cloneBrain(remote, targetPath, { repoPath })
      if (result.ok) {
        const location =
          requireBrainLocation(repoPath) ??
          authorizeBrainLocation(externalLocation(targetPath, remote))
        void refreshCompanyContext(repoPath, location, readInstalledAppSummaries())
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
          requireBrainLocation(repoPath) ??
          authorizeBrainLocation(externalLocation(brainPath, request?.remote))
        void refreshCompanyContext(repoPath, location, readInstalledAppSummaries())
      }
      return result
    }
  )

  // Why: `migrate` moves an embedded brain out — it has nothing to do for a
  // repo with no `.buildex/` to move, which is exactly the brand-new-company
  // path ("we want a brain repo of our own from day one"). This is what that
  // path actually calls: point the repo at a brain that already exists, and
  // touch nothing else.
  ipcMain.handle(
    'buildex-brain:bind',
    async (_event, request?: BrainBindRequest): Promise<BrainBindResult> => {
      const repoPath = request?.repoPath?.trim()
      const brainPath = request?.brainPath?.trim()
      if (!repoPath || !brainPath) {
        return { ok: false, error: 'Missing repoPath or brainPath' }
      }
      const result = await bindExistingBrain({
        repoPath,
        brainPath,
        ...(request?.remote ? { remote: request.remote } : {}),
        writePointer: Boolean(request?.writePointer)
      })
      if (result.ok) {
        const location =
          requireBrainLocation(repoPath) ??
          authorizeBrainLocation(externalLocation(brainPath, request?.remote))
        void refreshCompanyContext(repoPath, location, readInstalledAppSummaries())
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
        void refreshCompanyContext(repoPath, location, readInstalledAppSummaries())
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

  // Why: the retry behind "saved here, not shared yet". The commit already
  // landed, so this shares it without touching the working tree again.
  ipcMain.handle(
    'buildex-brain:push',
    async (_event, request?: BrainPushRequest): Promise<BrainPushResult> => {
      const repoPath = request?.repoPath?.trim()
      const location = repoPath ? requireBrainLocation(repoPath) : null
      if (!location) {
        return { pushed: false, error: BRAIN_UNRESOLVED }
      }
      return reportPush(await pushBrain(location))
    }
  )
}
