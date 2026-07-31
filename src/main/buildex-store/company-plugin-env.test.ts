import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreCatalog, StoreEntry } from '../../shared/buildex-store-types'
import { EMPTY_STORE_CATALOG } from '../../shared/buildex-store-types'

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v) }
}))

// The shelf itself is somebody else's test: what matters here is which company's
// keys are read for it, and whether it is consulted at all.
const readAppStoreCatalog = vi.fn<() => StoreCatalog>()
vi.mock('./store-catalog-source', () => ({ readAppStoreCatalog: () => readAppStoreCatalog() }))

const { applyCompanyPluginEnv } = await import('./company-plugin-env')
const { resolveCompanyIdentity } = await import('../buildex-company-identity')

let dir = ''
let userDataPath = ''

const STRIPE: StoreEntry = {
  plugin: {
    name: 'stripe',
    displayName: 'Stripe',
    description: '',
    category: null,
    author: null,
    homepage: null,
    keywords: [],
    source: { kind: 'marketplace-relative', path: 'plugins/stripe' }
  },
  marketplaceId: 'buildex-packs',
  marketplaceLabel: 'BuildEx',
  segment: 'business',
  curated: true,
  overlay: { pluginName: 'stripe', apiKey: { transport: 'mcp-bearer' } },
  installed: true
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'buildex-company-env-'))
  userDataPath = path.join(dir, 'userData')
  readAppStoreCatalog.mockReset()
  readAppStoreCatalog.mockReturnValue({ ...EMPTY_STORE_CATALOG, entries: [STRIPE] })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function company(name: string, stripeKey: string | null): string {
  const repo = path.join(dir, name)
  mkdirSync(path.join(repo, '.git'), { recursive: true })
  if (stripeKey !== null) {
    const key = resolveCompanyIdentity(repo)!.key
    mkdirSync(path.join(userDataPath, 'pack-credentials', key), { recursive: true })
    writeFileSync(path.join(userDataPath, 'pack-credentials', key, 'stripe.enc'), stripeKey, 'utf8')
  }
  return repo
}

function envFor(workspacePath: string | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  applyCompanyPluginEnv(env, { workspacePath, userDataPath })
  return env
}

describe('applyCompanyPluginEnv', () => {
  it('gives two businesses different keys in their terminals', () => {
    const acme = company('acme', 'sk_acme')
    const beta = company('beta', 'sk_beta')

    expect(envFor(acme)).toEqual({ BUILDEX_STRIPE_API_KEY: 'sk_acme' })
    expect(envFor(beta)).toEqual({ BUILDEX_STRIPE_API_KEY: 'sk_beta' })
  })

  it('gives every worktree of one business the same key', () => {
    const acme = company('acme', 'sk_acme')
    mkdirSync(path.join(acme, '.git', 'worktrees', 'invoices'), { recursive: true })
    const worktree = path.join(dir, 'acme-invoices')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(acme, '.git', 'worktrees', 'invoices')}\n`
    )

    expect(envFor(worktree)).toEqual({ BUILDEX_STRIPE_API_KEY: 'sk_acme' })
  })

  it('gives a workspace that is not a company nothing, and does not even read the shelf', () => {
    const scratch = path.join(dir, 'downloads')
    mkdirSync(scratch, { recursive: true })
    // Why: a pre-company key would otherwise reach a shell that belongs to no
    // business at all — every key on the machine, in every terminal.
    mkdirSync(path.join(userDataPath, 'pack-credentials'), { recursive: true })
    writeFileSync(path.join(userDataPath, 'pack-credentials', 'stripe.enc'), 'sk_legacy', 'utf8')

    expect(envFor(scratch)).toEqual({})
    expect(envFor(undefined)).toEqual({})
    expect(readAppStoreCatalog).not.toHaveBeenCalled()
  })

  it('falls back to a pre-company key for a business that has none of its own', () => {
    const acme = company('acme', null)
    mkdirSync(path.join(userDataPath, 'pack-credentials'), { recursive: true })
    writeFileSync(path.join(userDataPath, 'pack-credentials', 'stripe.enc'), 'sk_legacy', 'utf8')

    expect(envFor(acme)).toEqual({ BUILDEX_STRIPE_API_KEY: 'sk_legacy' })
  })

  it('leaves a variable the operator exported alone', () => {
    const acme = company('acme', 'sk_acme')
    const env = { BUILDEX_STRIPE_API_KEY: 'sk_from_shell' }

    applyCompanyPluginEnv(env, { workspacePath: acme, userDataPath })

    expect(env).toEqual({ BUILDEX_STRIPE_API_KEY: 'sk_from_shell' })
  })

  it('opens the terminal anyway when the shelf cannot be read', () => {
    const acme = company('acme', 'sk_acme')
    readAppStoreCatalog.mockImplementation(() => {
      throw new Error('no catalog')
    })

    expect(envFor(acme)).toEqual({})
  })
})
