import { ipcMain } from 'electron'
import type {
  PackCatalog,
  PackCatalogRequest,
  PackInstallRequest,
  PackInstallResult,
  PackRefreshResult
} from '../../shared/buildex-packs-types'
import { EMPTY_PACK_CATALOG } from '../../shared/buildex-packs-types'
import { readPackCatalog } from '../buildex-packs/pack-catalog'
import { installPack } from '../buildex-packs/pack-install'
import { refreshInstalledPacks } from '../buildex-packs/pack-refresh'
import { bundledCatalogRoot, initializeCompanyRepo } from '../buildex-repo-init'

export function registerBuildExPackHandlers(): void {
  ipcMain.handle('buildex-packs:catalog', (_event, request?: PackCatalogRequest): PackCatalog => {
    const repoPath = request?.repoPath?.trim()
    if (!repoPath) {
      return EMPTY_PACK_CATALOG
    }
    initializeCompanyRepo(repoPath)
    return readPackCatalog(repoPath, bundledCatalogRoot())
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
      return installPack(repoPath, packId, bundledCatalogRoot())
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
