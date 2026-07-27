import { app, ipcMain } from 'electron'
import type {
  PackCatalog,
  PackCredentialClearRequest,
  PackCredentialResult,
  PackCredentialSaveRequest,
  PackCatalogRequest,
  PackInstallRequest,
  PackInstallResult,
  PackRefreshResult,
  PackUninstallRequest,
  PackUninstallResult
} from '../../shared/buildex-packs-types'
import type { BuildExPack } from '../../shared/buildex-packs-types'
import { EMPTY_PACK_CATALOG } from '../../shared/buildex-packs-types'
import { readPackCatalog } from '../buildex-packs/pack-catalog'
import {
  clearPackCredential,
  hasPackCredential,
  packCredentialStatus,
  savePackCredential
} from '../buildex-packs/pack-credentials'
import { installPack } from '../buildex-packs/pack-install'
import { refreshInstalledPacks } from '../buildex-packs/pack-refresh'
import { uninstallPack } from '../buildex-packs/pack-uninstall'
import { refreshCompanyContext } from '../buildex-brain/company-context-refresh'
import { bundledCatalogRoot, initializeCompanyRepo } from '../buildex-repo-init'

/** Stamp each pack with whether this machine holds its key. */
function withCredentialStatus(catalog: PackCatalog): PackCatalog {
  const deps = { userDataPath: app.getPath('userData') }
  return {
    ...catalog,
    packs: catalog.packs.map((pack) => ({
      ...pack,
      credentialConnected: pack.apiKey ? hasPackCredential(deps, pack.id) : undefined
    }))
  }
}

/** Look a pack up in the shipped catalog; credentials are per pack, not per repo. */
function findPack(packId: string): BuildExPack | undefined {
  return readPackCatalog('', bundledCatalogRoot()).packs.find((pack) => pack.id === packId)
}

export function registerBuildExPackHandlers(): void {
  ipcMain.handle('buildex-packs:catalog', (_event, request?: PackCatalogRequest): PackCatalog => {
    const repoPath = request?.repoPath?.trim()
    // Why: with no project open there is nowhere to install to, but the operator
    // should still see what BuildEx can do — an empty shelf on first launch says
    // the product has nothing to offer, which is the opposite of true. Packs read
    // back as not-installed, and the Store disables Install with the reason.
    if (!repoPath) {
      return withCredentialStatus({
        ...EMPTY_PACK_CATALOG,
        ...readPackCatalog('', bundledCatalogRoot())
      })
    }
    initializeCompanyRepo(repoPath)
    return withCredentialStatus(readPackCatalog(repoPath, bundledCatalogRoot()))
  })

  ipcMain.handle(
    'buildex-packs:install',
    (_event, request?: PackInstallRequest): PackInstallResult => {
      const repoPath = request?.repoPath?.trim()
      const packId = request?.packId?.trim()
      if (!repoPath || !packId) {
        return {
          ok: false,
          writtenPaths: [],
          keptOperatorEdits: [],
          error: 'Missing repoPath or packId'
        }
      }
      const result = installPack(repoPath, packId, bundledCatalogRoot())
      if (result.ok) {
        // Why: the agent has to be told the app exists and which skills came with
        // it, or an install is invisible until the next time the Brain is opened.
        void refreshCompanyContext(repoPath, { bundledCatalogRoot: bundledCatalogRoot() })
      }
      return result
    }
  )

  // Why: the key crosses this boundary once, inbound. It is never returned to
  // the renderer — only whether one is stored, and under which variable.
  ipcMain.handle(
    'buildex-packs:saveCredential',
    (_event, request?: PackCredentialSaveRequest): PackCredentialResult => {
      const packId = request?.packId?.trim()
      const apiKey = request?.apiKey
      if (!packId || typeof apiKey !== 'string') {
        return { ok: false, status: null, error: 'Missing packId or apiKey' }
      }
      const pack = findPack(packId)
      if (!pack) {
        return { ok: false, status: null, error: `Unknown pack: ${packId}` }
      }
      const deps = { userDataPath: app.getPath('userData') }
      const outcome = savePackCredential(deps, packId, apiKey)
      if (!outcome.ok) {
        return { ok: false, status: null, error: outcome.error }
      }
      return {
        ok: true,
        status: packCredentialStatus(deps, pack),
        // Why: say so rather than quietly downgrading the protection.
        ...(outcome.encrypted
          ? {}
          : { error: 'Saved without OS encryption — this machine has no keychain available.' })
      }
    }
  )

  ipcMain.handle(
    'buildex-packs:clearCredential',
    (_event, request?: PackCredentialClearRequest): PackCredentialResult => {
      const packId = request?.packId?.trim()
      if (!packId) {
        return { ok: false, status: null, error: 'Missing packId' }
      }
      const deps = { userDataPath: app.getPath('userData') }
      clearPackCredential(deps, packId)
      const pack = findPack(packId)
      return { ok: true, status: pack ? packCredentialStatus(deps, pack) : null }
    }
  )

  ipcMain.handle(
    'buildex-packs:uninstall',
    (_event, request?: PackUninstallRequest): PackUninstallResult => {
      const repoPath = request?.repoPath?.trim()
      const packId = request?.packId?.trim()
      if (!repoPath || !packId) {
        return {
          ok: false,
          removedPaths: [],
          keptOperatorEdits: [],
          error: 'Missing repoPath or packId'
        }
      }
      const result = uninstallPack(repoPath, packId, bundledCatalogRoot())
      if (result.ok) {
        // Same in reverse: an agent still being told to reach for a removed app
        // would keep trying tools that are no longer there.
        void refreshCompanyContext(repoPath, { bundledCatalogRoot: bundledCatalogRoot() })
      }
      return result
    }
  )

  ipcMain.handle(
    'buildex-packs:refresh',
    (_event, request?: PackCatalogRequest): PackRefreshResult => {
      const repoPath = request?.repoPath?.trim()
      if (!repoPath) {
        return { updatedPackIds: [], writtenPaths: [], keptOperatorEdits: [] }
      }
      return refreshInstalledPacks(repoPath, bundledCatalogRoot())
    }
  )
}
