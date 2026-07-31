import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// No keychain here, which is the same path a Linux box with no keyring takes in
// production and keeps the stored bytes readable by the assertions.
vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v) }
}))

const { clearPluginCredential, hasPluginCredential, readPluginCredential, savePluginCredential } =
  await import('./plugin-credentials')

let userDataPath = ''

const ACME = 'acme-0123456789abcdef'
const BETA = 'beta-fedcba9876543210'

beforeEach(() => {
  userDataPath = mkdtempSync(path.join(tmpdir(), 'buildex-credentials-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

/** A key saved by a build that had never heard of companies. */
function writePreCompanyKey(pluginName: string, value: string): string {
  const at = path.join(userDataPath, 'pack-credentials', `${pluginName}.enc`)
  mkdirSync(path.dirname(at), { recursive: true })
  writeFileSync(at, value, 'utf8')
  return at
}

describe('savePluginCredential', () => {
  it('files a key under the company it was given in', () => {
    expect(savePluginCredential({ userDataPath, companyKey: ACME }, 'stripe', 'sk_acme')).toEqual({
      ok: true,
      encrypted: false
    })

    expect(
      readFileSync(path.join(userDataPath, 'pack-credentials', ACME, 'stripe.enc'), 'utf8')
    ).toBe('sk_acme')
  })

  it('keeps two businesses’ keys for one plugin apart', () => {
    savePluginCredential({ userDataPath, companyKey: ACME }, 'stripe', 'sk_acme')
    savePluginCredential({ userDataPath, companyKey: BETA }, 'stripe', 'sk_beta')

    expect(readPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBe('sk_acme')
    expect(readPluginCredential({ userDataPath, companyKey: BETA }, 'stripe')).toBe('sk_beta')
  })

  it('leaves a pre-company key exactly where it was, so an older build still finds it', () => {
    const preCompanyKeyFile = writePreCompanyKey('stripe', 'sk_legacy')

    savePluginCredential({ userDataPath, companyKey: ACME }, 'stripe', 'sk_acme')

    expect(readFileSync(preCompanyKeyFile, 'utf8')).toBe('sk_legacy')
  })

  it('refuses a company name that is not one, rather than writing to the shared slot', () => {
    const outcome = savePluginCredential({ userDataPath, companyKey: '../..' }, 'stripe', 'sk_acme')

    expect(outcome.ok).toBe(false)
    expect(existsSync(path.join(userDataPath, 'pack-credentials', 'stripe.enc'))).toBe(false)
  })

  it('refuses a plugin name that could walk out of the folder', () => {
    expect(savePluginCredential({ userDataPath, companyKey: ACME }, '../escape', 'sk').ok).toBe(
      false
    )
  })

  it('refuses to write the shared slot when there is no company at all', () => {
    // Defence in depth: the IPC refuses first, and this is the layer that makes
    // the shared file unreachable by any write.
    expect(savePluginCredential({ userDataPath }, 'stripe', 'sk_nobody').ok).toBe(false)
    expect(existsSync(path.join(userDataPath, 'pack-credentials', 'stripe.enc'))).toBe(false)
  })
})

describe('readPluginCredential', () => {
  it('falls back to a pre-company key for a company that has none of its own', () => {
    writePreCompanyKey('stripe', 'sk_legacy')

    expect(readPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBe('sk_legacy')
    expect(hasPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBe(true)
  })

  it('prefers the company’s own key over the pre-company one', () => {
    writePreCompanyKey('stripe', 'sk_legacy')
    savePluginCredential({ userDataPath, companyKey: ACME }, 'stripe', 'sk_acme')

    expect(readPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBe('sk_acme')
  })

  it('has nothing for a plugin nobody has configured, which is a normal state', () => {
    expect(readPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBeNull()
    expect(hasPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBe(false)
  })

  it('reads the pre-company slot when there is no company at all', () => {
    writePreCompanyKey('stripe', 'sk_legacy')

    expect(readPluginCredential({ userDataPath }, 'stripe')).toBe('sk_legacy')
  })

  it('treats an empty file as no key', () => {
    writePreCompanyKey('stripe', '')

    expect(readPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBeNull()
  })
})

describe('clearPluginCredential', () => {
  it('removes this company’s key and leaves the other company’s alone', () => {
    savePluginCredential({ userDataPath, companyKey: ACME }, 'stripe', 'sk_acme')
    savePluginCredential({ userDataPath, companyKey: BETA }, 'stripe', 'sk_beta')

    clearPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')

    expect(hasPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBe(false)
    expect(readPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBeNull()
    expect(hasPluginCredential({ userDataPath, companyKey: BETA }, 'stripe')).toBe(true)
    expect(readPluginCredential({ userDataPath, companyKey: BETA }, 'stripe')).toBe('sk_beta')
  })

  it('disconnects a company that was living on the pre-company key', () => {
    // Why: it is what "Connected" was reporting, so leaving it answering would
    // make the Disconnect button a lie.
    const preCompanyKeyFile = writePreCompanyKey('stripe', 'sk_legacy')

    clearPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')

    expect(hasPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBe(false)
    expect(readPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBeNull()
    // And the shared file is still there for everyone else.
    expect(readFileSync(preCompanyKeyFile, 'utf8')).toBe('sk_legacy')
    expect(hasPluginCredential({ userDataPath, companyKey: BETA }, 'stripe')).toBe(true)
    expect(readPluginCredential({ userDataPath, companyKey: BETA }, 'stripe')).toBe('sk_legacy')
  })

  it('disconnects a company that has both its own key and a pre-company one behind it', () => {
    // The upgrade shape, and the one that used to reconnect itself: removing
    // ACME's file let the pre-company key answer again — the very key the
    // operator was trying to stop using.
    const preCompanyKeyFile = writePreCompanyKey('stripe', 'sk_legacy')
    savePluginCredential({ userDataPath, companyKey: ACME }, 'stripe', 'sk_acme')

    clearPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')

    expect(hasPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBe(false)
    expect(readPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBeNull()
    expect(readFileSync(preCompanyKeyFile, 'utf8')).toBe('sk_legacy')
  })

  it('reconnects when the operator saves again', () => {
    writePreCompanyKey('stripe', 'sk_legacy')
    clearPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')

    savePluginCredential({ userDataPath, companyKey: ACME }, 'stripe', 'sk_acme')

    expect(hasPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBe(true)
    expect(readPluginCredential({ userDataPath, companyKey: ACME }, 'stripe')).toBe('sk_acme')
  })

  it('touches nothing when there is no company, because the shared key is not ours to remove', () => {
    const preCompanyKeyFile = writePreCompanyKey('stripe', 'sk_legacy')

    clearPluginCredential({ userDataPath }, 'stripe')

    expect(readFileSync(preCompanyKeyFile, 'utf8')).toBe('sk_legacy')
    expect(hasPluginCredential({ userDataPath }, 'stripe')).toBe(true)
  })
})
