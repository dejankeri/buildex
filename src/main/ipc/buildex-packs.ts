import { ipcMain } from 'electron'
import type {
  PackCatalog,
  PackCatalogRequest,
  PackInstallRequest,
  PackInstallResult
} from '../../shared/buildex-packs-types'
import { EMPTY_PACK_CATALOG } from '../../shared/buildex-packs-types'
import { readPackCatalog } from '../buildex-packs/pack-catalog'
import { installPack } from '../buildex-packs/pack-install'

export function registerBuildExPackHandlers(): void {
  ipcMain.handle('buildex-packs:catalog', (_event, request?: PackCatalogRequest): PackCatalog => {
    const repoPath = request?.repoPath?.trim()
    return repoPath ? readPackCatalog(repoPath) : EMPTY_PACK_CATALOG
  })

  ipcMain.handle(
    'buildex-packs:install',
    (_event, request?: PackInstallRequest): PackInstallResult => {
      const repoPath = request?.repoPath?.trim()
      const packId = request?.packId?.trim()
      if (!repoPath || !packId) {
        return { ok: false, writtenPaths: [], error: 'Missing repoPath or packId' }
      }
      return installPack(repoPath, packId)
    }
  )
}
