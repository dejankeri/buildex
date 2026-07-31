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
// and is still read, for any company with none of its own. That file is
// **read-only, without exception**: nothing here writes it, moves it or removes
// it, so downgrading to an older build finds every key where it left it and one
// business can never disconnect another's.
//
// Which is why disconnecting is a marker file rather than a deletion. Every
// write this module makes lands in `pack-credentials/<companyKey>/`, so the only
// way to say "not here" about a shared key is to shadow it from inside the
// company's own folder.
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

/**
 * This company's own folder. Null when there is no company to own one — and
 * never the shared root, because a key meant for one business landing where
 * every business reads it is the failure this whole change exists to remove.
 */
function companyDir(deps: PluginCredentialDeps): string | null {
  if (!deps.companyKey || !COMPANY_KEY_RE.test(deps.companyKey)) {
    return null
  }
  return path.join(deps.userDataPath, CREDENTIAL_DIR_NAME, deps.companyKey)
}

/** This company's key file — the only path anything here ever writes or removes. */
function companyCredentialPath(deps: PluginCredentialDeps, pluginName: string): string | null {
  const dir = companyDir(deps)
  return dir && PLUGIN_NAME_RE.test(pluginName) ? path.join(dir, `${pluginName}.enc`) : null
}

/**
 * "This company disconnected this plugin."
 *
 * Written on Disconnect, and the reason it exists: the pre-company key is shared
 * with every other business, so removing it is not this company's to do — but
 * leaving it answering here would reconnect the plugin the instant the operator
 * disconnected it. The marker shadows it here and nowhere else.
 */
function disconnectedMarkerPath(deps: PluginCredentialDeps, pluginName: string): string | null {
  const dir = companyDir(deps)
  return dir && PLUGIN_NAME_RE.test(pluginName)
    ? path.join(dir, `${pluginName}.disconnected`)
    : null
}

/** The pre-company slot, shared by every business. Read-only, always. */
function preCompanyCredentialPath(deps: PluginCredentialDeps, pluginName: string): string | null {
  return PLUGIN_NAME_RE.test(pluginName)
    ? path.join(deps.userDataPath, CREDENTIAL_DIR_NAME, `${pluginName}.enc`)
    : null
}

function holdsSomething(target: string): boolean {
  try {
    return existsSync(target) && readFileSync(target).length > 0
  } catch {
    // Unreadable is indistinguishable from absent to everyone downstream.
    return false
  }
}

/** The file this company reads from, or null when it has no key by any route. */
function storedCredentialPath(deps: PluginCredentialDeps, pluginName: string): string | null {
  const marker = disconnectedMarkerPath(deps, pluginName)
  if (marker && existsSync(marker)) {
    return null
  }
  const own = companyCredentialPath(deps, pluginName)
  if (own && holdsSomething(own)) {
    return own
  }
  const preCompany = preCompanyCredentialPath(deps, pluginName)
  return preCompany && holdsSomething(preCompany) ? preCompany : null
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
  // No company, no save. The caller is expected to have refused already; this is
  // the layer that makes the shared slot unreachable by a write at all.
  const target = companyCredentialPath(deps, pluginName)
  const marker = disconnectedMarkerPath(deps, pluginName)
  if (!target || !marker) {
    return { ok: false, error: `Nowhere to store a key for ${pluginName}` }
  }
  const trimmed = apiKey.trim()
  if (!trimmed) {
    return { ok: false, error: 'Empty key' }
  }
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    let encrypted = false
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(target, safeStorage.encryptString(trimmed), { mode: 0o600 })
      encrypted = true
    } else {
      writeFileSync(target, trimmed, { encoding: 'utf8', mode: 0o600 })
    }
    // Reconnecting: lift this company's own disconnect. After the write, so a
    // failure here leaves the plugin disconnected rather than quietly back on a
    // pre-company key.
    rmSync(marker, { force: true })
    return { ok: true, encrypted }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Disconnect, scoped to this company and only this company.
 *
 * Two writes, both inside `pack-credentials/<companyKey>/`: this company's key
 * goes, and a marker goes down saying it disconnected. The shared pre-company
 * file is never touched — the operator disconnected one business, and deleting
 * it would silently disconnect every other one reading through the fallback.
 *
 * Without a company there is nothing of ours to remove and nothing we may
 * remove, so this is a no-op; the caller refuses that case with a message.
 */
export function clearPluginCredential(deps: PluginCredentialDeps, pluginName: string): void {
  const target = companyCredentialPath(deps, pluginName)
  const marker = disconnectedMarkerPath(deps, pluginName)
  if (!target || !marker) {
    return
  }
  try {
    rmSync(target, { force: true })
    mkdirSync(path.dirname(marker), { recursive: true })
    writeFileSync(marker, '', { mode: 0o600 })
  } catch {
    // A marker we could not write leaves the plugin connected here, which the
    // Store reports honestly on its next read.
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
