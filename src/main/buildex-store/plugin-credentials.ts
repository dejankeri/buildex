import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { StoreApiKey, StoreCredentialStatus } from '../../shared/buildex-store-types'

// Where an installed plugin's API key lives.
//
// Not in the company repo: a key in a repo is a key in a backup, a diff, and
// eventually a push. Not in ~/.orca either, which the operator's other editor
// owns — BuildEx keeps its own credentials under its own userData.
//
// Per company, because two businesses each with their own Stripe account is the
// whole point of the product: `pack-credentials/<companyKey>/<plugin>.enc`. The
// company is named by the caller, which knows the workspace; this module only
// files what it is given.
//
// A key saved before companies existed sits at `pack-credentials/<plugin>.enc`
// and is still read, for any company with none of its own. That fallback is
// read-only in both directions — saving never moves it, so downgrading to an
// older build finds every key where it left it.
//
// Encrypted with safeStorage, which is the OS keychain on macOS and Windows.
// Where that is unavailable the file is written 0600 in plaintext and the caller
// is told, because silently downgrading a credential's protection is worse than
// saying so.
//
// This is the half of a pack that delegating install does not move: the plugin
// carries an `${ENV}` reference in its own .mcp.json, and BuildEx is what puts a
// value behind it at terminal launch.

const CREDENTIAL_DIR_NAME = 'pack-credentials'
/** Only these become filenames, so a plugin name cannot walk out of the folder. */
const PLUGIN_NAME_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i
/** Same for the company folder: only the shape `resolveCompanyIdentity` mints. */
const COMPANY_KEY_RE = /^[a-z0-9][a-z0-9-]*$/

export type PluginCredentialDeps = {
  /** The app's userData directory. Injected so this stays testable. */
  userDataPath: string
  /**
   * The company these credentials belong to, from `resolveCompanyIdentity`.
   * Absent means no company was resolved, and only the pre-company global slot
   * is in play.
   */
  companyKey?: string | null
}

/**
 * The environment variable a plugin's key is exposed as.
 *
 * Honours an explicit envKey from the overlay — that is how PROTOCOL_API_KEY
 * keeps its name — and otherwise derives one that cannot collide with an
 * unrelated variable.
 */
export function envKeyForPlugin(pluginName: string, apiKey?: StoreApiKey): string {
  return apiKey?.envKey ?? `BUILDEX_${pluginName.replace(/[-.]/g, '_').toUpperCase()}_API_KEY`
}

function credentialDir(deps: PluginCredentialDeps): string | null {
  const root = path.join(deps.userDataPath, CREDENTIAL_DIR_NAME)
  if (!deps.companyKey) {
    return root
  }
  // Never quietly fall back to the shared folder: a key meant for one company
  // landing where every company reads it is the failure this whole change exists
  // to remove.
  return COMPANY_KEY_RE.test(deps.companyKey) ? path.join(root, deps.companyKey) : null
}

function credentialPath(deps: PluginCredentialDeps, pluginName: string): string | null {
  const dir = credentialDir(deps)
  if (!dir || !PLUGIN_NAME_RE.test(pluginName)) {
    return null
  }
  return path.join(dir, `${pluginName}.enc`)
}

/**
 * Where this company's key is, then where a pre-company one would be. Ordered:
 * the first that holds anything is the one this company is using.
 */
function credentialPaths(deps: PluginCredentialDeps, pluginName: string): string[] {
  const own = credentialPath(deps, pluginName)
  if (!own) {
    return []
  }
  const preCompany = credentialPath({ userDataPath: deps.userDataPath }, pluginName)
  return preCompany && preCompany !== own ? [own, preCompany] : [own]
}

/** The file this company reads from, or null when it has no key by either route. */
function storedCredentialPath(deps: PluginCredentialDeps, pluginName: string): string | null {
  for (const candidate of credentialPaths(deps, pluginName)) {
    try {
      if (existsSync(candidate) && readFileSync(candidate).length > 0) {
        return candidate
      }
    } catch {
      // Unreadable is indistinguishable from absent to everyone downstream.
    }
  }
  return null
}

export function hasPluginCredential(deps: PluginCredentialDeps, pluginName: string): boolean {
  return storedCredentialPath(deps, pluginName) !== null
}

export type SaveOutcome = { ok: true; encrypted: boolean } | { ok: false; error: string }

export function savePluginCredential(
  deps: PluginCredentialDeps,
  pluginName: string,
  apiKey: string
): SaveOutcome {
  const target = credentialPath(deps, pluginName)
  if (!target) {
    return { ok: false, error: `Nowhere to store a key for ${pluginName}` }
  }
  const trimmed = apiKey.trim()
  if (!trimmed) {
    return { ok: false, error: 'Empty key' }
  }
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(target, safeStorage.encryptString(trimmed), { mode: 0o600 })
      return { ok: true, encrypted: true }
    }
    writeFileSync(target, trimmed, { encoding: 'utf8', mode: 0o600 })
    return { ok: true, encrypted: false }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Disconnect removes the key this company is actually using — its own when it
 * has one, and otherwise the pre-company key that was answering for it.
 *
 * Removing only the company file would leave the fallback still connected and
 * make the button a lie; removing both would disconnect companies the operator
 * said nothing about.
 */
export function clearPluginCredential(deps: PluginCredentialDeps, pluginName: string): void {
  const target = storedCredentialPath(deps, pluginName)
  if (!target) {
    // Nothing stored is already the outcome the caller wanted.
    return
  }
  try {
    rmSync(target)
  } catch {
    // Removed by something else in the meantime; same outcome.
  }
}

/**
 * Read a key back for injection into an agent's environment. Returns null rather
 * than throwing: a key we cannot decrypt (the operator declined the keychain
 * prompt after a re-sign) must not stop a terminal from opening.
 */
export function readPluginCredential(
  deps: PluginCredentialDeps,
  pluginName: string
): string | null {
  const target = storedCredentialPath(deps, pluginName)
  if (!target) {
    return null
  }
  try {
    const raw = readFileSync(target)
    if (raw.length === 0) {
      return null
    }
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(raw) || null
      } catch {
        // Written before encryption became available on this machine.
        return raw.toString('utf8').trim() || null
      }
    }
    return raw.toString('utf8').trim() || null
  } catch {
    return null
  }
}

export function pluginCredentialStatus(
  deps: PluginCredentialDeps,
  pluginName: string,
  apiKey?: StoreApiKey
): StoreCredentialStatus {
  return {
    pluginName,
    connected: hasPluginCredential(deps, pluginName),
    envKey: envKeyForPlugin(pluginName, apiKey)
  }
}
