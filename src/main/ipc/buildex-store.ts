import { homedir } from 'node:os'
import { app, ipcMain } from 'electron'
import type {
  StoreCatalog,
  StoreCatalogRequest,
  StoreCredentialClearRequest,
  StoreCredentialResult,
  StoreCredentialSaveRequest,
  StoreEntry,
  StoreInstallRequest,
  StoreInstallResult,
  StoreRoster,
  StoreRefreshResult,
  StoreRosterResult,
  StoreRosterSetRequest
} from '../../shared/buildex-store-types'
import { EMPTY_STORE_CATALOG } from '../../shared/buildex-store-types'
import { readStoreRoster, setRosterEntry } from '../buildex-store/store-roster'
import { readAppStoreCatalog, refreshAppStoreCatalog } from '../buildex-store/store-catalog-source'
import { installClaudePlugin, uninstallClaudePlugin } from '../buildex-store/claude-plugin-install'
import { resolveClaudeBinary, runClaudeCommand } from '../buildex-store/claude-cli-runner'
import { unsupportedInstallAgent } from '../buildex-store/store-agent-support'
import { collectPluginGateRules } from '../buildex-store/plugin-env'
import {
  clearPluginCredential,
  pluginCredentialStatus,
  savePluginCredential
} from '../buildex-store/plugin-credentials'
import { syncGateSettings } from '../buildex-gate/gate-settings'
import { embeddedLocation, requireBrainLocation } from '../buildex-brain/brain-location'
import { refreshCompanyContext } from '../buildex-brain/company-context-refresh'
import { readInstalledPluginInventory } from '../buildex-store/installed-plugin-inventory'
import { initializeCompanyRepo } from '../buildex-repo-init'

// The Store's IPC surface.
//
// Reading the shelf is cheap and repo-independent: the marketplace indexes ship
// with the app, so the Store fills even before a project is open. Installing is
// the agent's own plugin CLI — BuildEx contributes the parts a marketplace does
// not carry, which is the gate, the credential, and the line the brain tells the
// agent about what this company now runs on.

function credentialDeps(): { userDataPath: string } {
  return { userDataPath: app.getPath('userData') }
}

function claudeDeps(): {
  homeDir: string
  run: (args: string[]) => ReturnType<typeof runClaudeCommand>
} {
  const homeDir = homedir()
  const binary = resolveClaudeBinary(homeDir)
  return { homeDir, run: (args) => runClaudeCommand(binary ?? 'claude', args) }
}

/**
 * The company's roster, or null when this repo has no brain to hold one.
 *
 * Read per call rather than cached: a teammate pulling a commit that adds an app
 * should see it the next time they open the Store, not after a restart.
 */
function readRoster(repoPath: string | undefined): StoreRoster | null {
  if (!repoPath) {
    return null
  }
  const location = requireBrainLocation(repoPath)
  return location ? readStoreRoster(location) : null
}

/** The shelf, with what this machine and this company know about each entry. */
function assembleCatalog(request?: StoreCatalogRequest): StoreCatalog {
  return readAppStoreCatalog({
    roster: readRoster(request?.repoPath?.trim()),
    unsupportedAgent: unsupportedInstallAgent(request?.agent)
  })
}

/**
 * Bring the repo in line with what is installed now.
 *
 * Both halves matter and neither is the agent's job: the gate has to name the
 * verbs an installed app wants gated, and the brain has to stop describing an
 * app that is gone. Failures here never fail the install itself — the plugin is
 * installed either way, and a stale context is a smaller problem than an install
 * that reports failure after succeeding.
 */
function syncRepoAfterChange(repoPath: string, entries: readonly StoreEntry[]): void {
  try {
    syncGateSettings(repoPath, collectPluginGateRules(entries))
  } catch {
    // The plugin is installed; a gate we could not write is visible in the Store.
  }
  try {
    const location = requireBrainLocation(repoPath) ?? embeddedLocation(repoPath)
    void refreshCompanyContext(repoPath, location, readInstalledPluginInventory(homedir(), entries))
  } catch {
    // A context we could not refresh reaches the agent on the next open.
  }
}

function findEntry(
  catalog: StoreCatalog,
  pluginName: string,
  marketplaceId: string
): StoreEntry | undefined {
  return catalog.entries.find(
    (entry) => entry.plugin.name === pluginName && entry.marketplaceId === marketplaceId
  )
}

export function registerBuildExStoreHandlers(): void {
  ipcMain.handle('buildex-store:catalog', (_event, request?: StoreCatalogRequest): StoreCatalog => {
    const repoPath = request?.repoPath?.trim()
    // Why: with no project open there is nowhere for the gate to land, but the
    // operator should still see what BuildEx can do. An empty shelf on first
    // launch says the product has nothing to offer, which is the opposite of true.
    if (repoPath) {
      initializeCompanyRepo(repoPath)
    }
    try {
      return assembleCatalog(request)
    } catch {
      return EMPTY_STORE_CATALOG
    }
  })

  // Why: indexes are fetched, not bundled, so this is how the shelf is filled the
  // first time and kept current after. Explicitly a separate call — reading the
  // catalog must never block on the network, because a terminal spawn reads it too.
  ipcMain.handle(
    'buildex-store:refresh',
    async (_event, request?: StoreCatalogRequest): Promise<StoreRefreshResult> => {
      try {
        return await refreshAppStoreCatalog({
          roster: readRoster(request?.repoPath?.trim()),
          unsupportedAgent: unsupportedInstallAgent(request?.agent)
        })
      } catch (error) {
        return {
          catalog: assembleCatalog(request),
          errors: [error instanceof Error ? error.message : String(error)]
        }
      }
    }
  )

  ipcMain.handle(
    'buildex-store:install',
    (_event, request?: StoreInstallRequest): StoreInstallResult => {
      const pluginName = request?.pluginName?.trim()
      const marketplaceId = request?.marketplaceId?.trim()
      if (!pluginName || !marketplaceId) {
        return { ok: false, error: 'Missing pluginName or marketplaceId' }
      }
      const unsupported = unsupportedInstallAgent(request?.agent)
      if (unsupported) {
        return { ok: false, error: `BuildEx cannot install plugins for ${unsupported} yet.` }
      }
      const catalog = assembleCatalog(request)
      const entry = findEntry(catalog, pluginName, marketplaceId)
      if (!entry) {
        return { ok: false, error: `Unknown plugin: ${pluginName}@${marketplaceId}` }
      }
      const marketplace = catalog.marketplaces.find((candidate) => candidate.id === marketplaceId)
      if (!marketplace) {
        return { ok: false, error: `Unknown marketplace: ${marketplaceId}` }
      }

      const result = installClaudePlugin(claudeDeps(), {
        pluginName,
        marketplaceId,
        marketplaceRepo: marketplace.repo
      })
      const repoPath = request?.repoPath?.trim()
      if (result.ok && repoPath) {
        // Re-read rather than assuming: the CLI is the authority on what is
        // installed, and an install that half-succeeded must not gate as if it had.
        syncRepoAfterChange(repoPath, assembleCatalog(request).entries)
      }
      return result
    }
  )

  ipcMain.handle(
    'buildex-store:uninstall',
    (_event, request?: StoreInstallRequest): StoreInstallResult => {
      const pluginName = request?.pluginName?.trim()
      const marketplaceId = request?.marketplaceId?.trim()
      if (!pluginName || !marketplaceId) {
        return { ok: false, error: 'Missing pluginName or marketplaceId' }
      }
      const result = uninstallClaudePlugin(claudeDeps(), { pluginName, marketplaceId })
      const repoPath = request?.repoPath?.trim()
      if (result.ok && repoPath) {
        // Same in reverse: an agent still told to reach for a removed app would
        // keep calling tools that are no longer there.
        syncRepoAfterChange(repoPath, assembleCatalog(request).entries)
      }
      return result
    }
  )

  // Why: the key crosses this boundary once, inbound. It is never returned to
  // the renderer — only whether one is stored, and under which variable.
  ipcMain.handle(
    'buildex-store:saveCredential',
    (_event, request?: StoreCredentialSaveRequest): StoreCredentialResult => {
      const pluginName = request?.pluginName?.trim()
      const apiKey = request?.apiKey
      if (!pluginName || typeof apiKey !== 'string') {
        return { ok: false, status: null, error: 'Missing pluginName or apiKey' }
      }
      const deps = credentialDeps()
      const outcome = savePluginCredential(deps, pluginName, apiKey)
      if (!outcome.ok) {
        return { ok: false, status: null, error: outcome.error }
      }
      const overlay = assembleCatalog().entries.find(
        (entry) => entry.plugin.name === pluginName
      )?.overlay
      return {
        ok: true,
        status: pluginCredentialStatus(deps, pluginName, overlay?.apiKey),
        // Why: say so rather than quietly downgrading the protection.
        ...(outcome.encrypted
          ? {}
          : { error: 'Saved without OS encryption — this machine has no keychain available.' })
      }
    }
  )

  // Why: the roster is the one part of an install that is shared. Marking an app
  // writes a small file in the brain, which the operator then commits like any
  // other company document — that is what makes it reach a teammate at all.
  ipcMain.handle(
    'buildex-store:setRosterEntry',
    (_event, request?: StoreRosterSetRequest): StoreRosterResult => {
      const repoPath = request?.repoPath?.trim()
      const pluginName = request?.pluginName?.trim()
      const marketplaceId = request?.marketplaceId?.trim()
      if (!repoPath || !pluginName || !marketplaceId) {
        return { ok: false, roster: null, error: 'Missing repoPath, pluginName or marketplaceId' }
      }
      const requirement = request?.requirement ?? null
      if (requirement !== null && requirement !== 'required' && requirement !== 'suggested') {
        return { ok: false, roster: null, error: `Unknown requirement: ${String(requirement)}` }
      }
      const location = requireBrainLocation(repoPath)
      if (!location) {
        // Nowhere to put it: the roster travels in the brain, so a repo without
        // one has no way to share what it expects.
        return {
          ok: false,
          roster: null,
          error: 'Set up a company brain first — the app list lives in it.'
        }
      }
      try {
        return {
          ok: true,
          roster: setRosterEntry(location, {
            pluginName,
            marketplaceId,
            requirement,
            reason: request?.reason
          })
        }
      } catch (error) {
        return {
          ok: false,
          roster: null,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  ipcMain.handle(
    'buildex-store:clearCredential',
    (_event, request?: StoreCredentialClearRequest): StoreCredentialResult => {
      const pluginName = request?.pluginName?.trim()
      if (!pluginName) {
        return { ok: false, status: null, error: 'Missing pluginName' }
      }
      const deps = credentialDeps()
      clearPluginCredential(deps, pluginName)
      const overlay = assembleCatalog().entries.find(
        (entry) => entry.plugin.name === pluginName
      )?.overlay
      return { ok: true, status: pluginCredentialStatus(deps, pluginName, overlay?.apiKey) }
    }
  )
}
