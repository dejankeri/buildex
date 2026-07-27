import { resolve } from 'node:path'
import { app, ipcMain } from 'electron'
import type {
  PackCatalog,
  PackCatalogRequest,
  PackInstallRequest,
  PackInstallResult,
  PackRefreshResult
} from '../../shared/buildex-packs-types'
import { EMPTY_PACK_CATALOG } from '../../shared/buildex-packs-types'
import { buildexCatalogRootFrom } from '../buildex-packs/bundled-catalog'
import { readPackCatalog } from '../buildex-packs/pack-catalog'
import { installPack } from '../buildex-packs/pack-install'
import { refreshInstalledPacks } from '../buildex-packs/pack-refresh'

// Why: packaged builds get the catalog from extraResources; a dev run reads the
// same tree straight out of the repo, so both modes see identical packs.
function bundledCatalogRoot(): string {
  const resourceRoot = app.isPackaged ? process.resourcesPath : resolve(process.cwd(), 'resources')
  return buildexCatalogRootFrom(resourceRoot)
}

// Why: the first time this run touches a repo, bring its installed packs up to
// the catalog this build ships — that is how an app update delivers improved
// skills. Once per repo per run: it is idempotent, but re-walking every pack on
// every catalog read would put filesystem writes behind a read.
const refreshedRepoPaths = new Set<string>()

function refreshOncePerRun(repoPath: string): void {
  if (refreshedRepoPaths.has(repoPath)) {
    return
  }
  refreshedRepoPaths.add(repoPath)
  try {
    refreshInstalledPacks(repoPath, bundledCatalogRoot())
  } catch {
    // A repo we cannot write to still deserves a readable Store.
  }
}

export function registerBuildExPackHandlers(): void {
  ipcMain.handle('buildex-packs:catalog', (_event, request?: PackCatalogRequest): PackCatalog => {
    const repoPath = request?.repoPath?.trim()
    if (!repoPath) {
      return EMPTY_PACK_CATALOG
    }
    refreshOncePerRun(repoPath)
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
