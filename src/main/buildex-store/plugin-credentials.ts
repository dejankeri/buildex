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

export type PluginCredentialDeps = {
  /** The app's userData directory. Injected so this stays testable. */
  userDataPath: string
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

function credentialDir(deps: PluginCredentialDeps): string {
  return path.join(deps.userDataPath, CREDENTIAL_DIR_NAME)
}

function credentialPath(deps: PluginCredentialDeps, pluginName: string): string | null {
  if (!PLUGIN_NAME_RE.test(pluginName)) {
    return null
  }
  return path.join(credentialDir(deps), `${pluginName}.enc`)
}

export function hasPluginCredential(deps: PluginCredentialDeps, pluginName: string): boolean {
  const target = credentialPath(deps, pluginName)
  if (!target) {
    return false
  }
  try {
    return readFileSync(target).length > 0
  } catch {
    return false
  }
}

export type SaveOutcome = { ok: true; encrypted: boolean } | { ok: false; error: string }

export function savePluginCredential(
  deps: PluginCredentialDeps,
  pluginName: string,
  apiKey: string
): SaveOutcome {
  const target = credentialPath(deps, pluginName)
  if (!target) {
    return { ok: false, error: `Unusable plugin name: ${pluginName}` }
  }
  const trimmed = apiKey.trim()
  if (!trimmed) {
    return { ok: false, error: 'Empty key' }
  }
  try {
    mkdirSync(credentialDir(deps), { recursive: true })
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

export function clearPluginCredential(deps: PluginCredentialDeps, pluginName: string): void {
  const target = credentialPath(deps, pluginName)
  if (!target) {
    return
  }
  try {
    rmSync(target)
  } catch {
    // Already gone is the outcome the caller wanted.
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
  const target = credentialPath(deps, pluginName)
  if (!target || !existsSync(target)) {
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
