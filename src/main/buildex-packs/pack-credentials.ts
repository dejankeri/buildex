import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { BuildExPack, PackCredentialStatus } from '../../shared/buildex-packs-types'

// Where a pack's API key lives.
//
// Not in the company repo: a key in a repo is a key in a backup, a diff, and
// eventually a push. Not in ~/.orca either, which the operator's other editor
// owns — BuildEx keeps its own credentials under its own userData.
//
// Encrypted with safeStorage, which is the OS keychain on macOS and Windows.
// Where that is unavailable the file is written 0600 in plaintext and the caller
// is told, because silently downgrading a credential's protection is worse than
// saying so.

const CREDENTIAL_DIR_NAME = 'pack-credentials'

export type PackCredentialDeps = {
  /** The app's userData directory. Injected so this stays testable. */
  userDataPath: string
}

/**
 * The environment variable a pack's key is exposed as. Honours an explicit
 * envKey from the manifest — that is how the old catalog named PROTOCOL_API_KEY
 * — and otherwise derives one that cannot collide with an unrelated variable.
 */
export function envKeyForPack(pack: BuildExPack): string {
  return pack.apiKey?.envKey ?? `BUILDEX_${pack.id.replace(/-/g, '_').toUpperCase()}_API_KEY`
}

function credentialDir(deps: PackCredentialDeps): string {
  return path.join(deps.userDataPath, CREDENTIAL_DIR_NAME)
}

/** Pack ids are charset-checked at parse time, so they are safe as filenames. */
function credentialPath(deps: PackCredentialDeps, packId: string): string {
  return path.join(credentialDir(deps), `${packId}.enc`)
}

export function hasPackCredential(deps: PackCredentialDeps, packId: string): boolean {
  try {
    return readFileSync(credentialPath(deps, packId)).length > 0
  } catch {
    return false
  }
}

export type SaveOutcome = { ok: true; encrypted: boolean } | { ok: false; error: string }

export function savePackCredential(
  deps: PackCredentialDeps,
  packId: string,
  apiKey: string
): SaveOutcome {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    return { ok: false, error: 'Empty key' }
  }
  try {
    mkdirSync(credentialDir(deps), { recursive: true })
    const target = credentialPath(deps, packId)
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

export function clearPackCredential(deps: PackCredentialDeps, packId: string): void {
  try {
    rmSync(credentialPath(deps, packId))
  } catch {
    // Already gone is the outcome the caller wanted.
  }
}

/**
 * Read a key back for injection into an agent's environment. Returns null rather
 * than throwing: a key we cannot decrypt (the operator declined the keychain
 * prompt after a re-sign) must not stop a terminal from opening.
 */
export function readPackCredential(deps: PackCredentialDeps, packId: string): string | null {
  const target = credentialPath(deps, packId)
  if (!existsSync(target)) {
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

export function packCredentialStatus(
  deps: PackCredentialDeps,
  pack: BuildExPack
): PackCredentialStatus {
  return {
    packId: pack.id,
    connected: hasPackCredential(deps, pack.id),
    envKey: envKeyForPack(pack)
  }
}
