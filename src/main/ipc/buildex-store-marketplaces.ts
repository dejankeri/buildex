import { app, ipcMain } from 'electron'
import type {
  CompanyMarketplace,
  StoreMarketplaceAddRequest,
  StoreMarketplaceRemoveRequest,
  StoreMarketplaceResult
} from '../../shared/buildex-store-types'
import {
  addCompanyMarketplace,
  marketplaceIdProblem,
  marketplaceSourceProblem,
  removeCompanyMarketplace
} from '../buildex-store/company-marketplaces'
import { RESERVED_MARKETPLACE_IDS } from '../buildex-store/marketplace-catalog'
import { fetchMarketplaceIndex } from '../buildex-store/marketplace-fetch'
import { parseMarketplaceManifest } from '../buildex-store/marketplace-manifest'
import { writeCachedIndex } from '../buildex-store/marketplace-index-cache'
import { requireBrainLocation } from '../buildex-brain/brain-location'

// Adding and removing the marketplaces a company reads.
//
// Separate from the rest of the Store's IPC because it is the only part that
// writes to the brain and fetches in the same call, and because the shelf's
// handlers have nothing to say about where marketplaces come from.

export function registerStoreMarketplaceHandlers(): void {
  // Why: a marketplace is where apps come from, so adding one is a company
  // decision, not a machine's. It lands in the brain next to the roster and
  // reaches a teammate the same way — by being committed.
  ipcMain.handle(
    'buildex-store:addMarketplace',
    async (_event, request?: StoreMarketplaceAddRequest): Promise<StoreMarketplaceResult> => {
      const repoPath = request?.repoPath?.trim()
      if (!repoPath) {
        return { ok: false, marketplaces: null, error: 'Missing repoPath' }
      }
      const label = request?.label?.trim() ?? ''
      const repo = request?.repo?.trim() ?? ''
      const typo = marketplaceSourceProblem({ label, repo })
      if (typo) {
        return { ok: false, marketplaces: null, error: typo }
      }
      const location = requireBrainLocation(repoPath)
      if (!location) {
        return {
          ok: false,
          marketplaces: null,
          error: 'Set up a company brain first — marketplaces live in it.'
        }
      }

      // Why fetch before writing: the id is not the operator's to choose. It has
      // to be the `name` the marketplace declares, because that is the key the
      // agent records installs under — an id we guessed would make every plugin
      // from here read as not-installed, forever and silently. So the marketplace
      // is asked what it calls itself, and one we cannot reach is one we cannot
      // add rather than one we add wrongly.
      const fetched = await fetchMarketplaceIndex(repo)
      if ('error' in fetched) {
        return { ok: false, marketplaces: null, error: `Could not read ${repo}: ${fetched.error}` }
      }
      const manifest = parseMarketplaceManifest(fetched.body)
      if (!manifest) {
        return { ok: false, marketplaces: null, error: `${repo} is not a marketplace.json.` }
      }
      const idProblem = marketplaceIdProblem(manifest.name, RESERVED_MARKETPLACE_IDS)
      if (idProblem) {
        return { ok: false, marketplaces: null, error: idProblem }
      }

      const marketplace: CompanyMarketplace = {
        id: manifest.name,
        label,
        repo,
        defaultSegment: request?.defaultSegment === 'software' ? 'software' : 'business'
      }
      try {
        const marketplaces = addCompanyMarketplace(location, marketplace)
        // The body is already in hand, so the apps are on the shelf as soon as
        // the dialog closes rather than after the next refresh.
        writeCachedIndex(app.getPath('userData'), marketplace.id, fetched.body, Date.now())
        return { ok: true, marketplaces }
      } catch (error) {
        return {
          ok: false,
          marketplaces: null,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  // Why: removing takes the marketplace off this company's shelf. Plugins already
  // installed from it stay installed — they belong to the agent, not to us, and
  // silently uninstalling someone's apps is not what "remove a source" means.
  ipcMain.handle(
    'buildex-store:removeMarketplace',
    (_event, request?: StoreMarketplaceRemoveRequest): StoreMarketplaceResult => {
      const repoPath = request?.repoPath?.trim()
      const id = request?.id?.trim()
      if (!repoPath || !id) {
        return { ok: false, marketplaces: null, error: 'Missing repoPath or id' }
      }
      if (RESERVED_MARKETPLACE_IDS.includes(id)) {
        return { ok: false, marketplaces: null, error: `${id} ships with BuildEx.` }
      }
      const location = requireBrainLocation(repoPath)
      if (!location) {
        return { ok: false, marketplaces: null, error: 'This repo has no company brain.' }
      }
      try {
        return { ok: true, marketplaces: removeCompanyMarketplace(location, id) }
      } catch (error) {
        return {
          ok: false,
          marketplaces: null,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
}
