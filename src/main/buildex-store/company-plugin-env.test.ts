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

const { applyCompanyPluginEnv, companyWorkspacePathForSpawn } = await import('./company-plugin-env')
const { resolveCompanyIdentity } = await import('../buildex-company-identity')
const { savePluginCredential } = await import('./plugin-credentials')

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

/** A git-repo business, with its key saved the way the Store's IPC saves it. */
function company(name: string, stripeKey: string | null): string {
  const repo = path.join(dir, name)
  mkdirSync(path.join(repo, '.git'), { recursive: true })
  return saveKeyFor(repo, stripeKey)
}

/** A business run out of a plain folder — no repo anywhere above it. */
function folderWorkspace(name: string, stripeKey: string | null): string {
  const folder = path.join(dir, name)
  mkdirSync(folder, { recursive: true })
  return saveKeyFor(folder, stripeKey)
}

function saveKeyFor(workspacePath: string, stripeKey: string | null): string {
  if (stripeKey !== null) {
    const companyKey = resolveCompanyIdentity(workspacePath)!.key
    expect(savePluginCredential({ userDataPath, companyKey }, 'stripe', stripeKey).ok).toBe(true)
  }
  return workspacePath
}

function preCompanyKey(value: string): void {
  mkdirSync(path.join(userDataPath, 'pack-credentials'), { recursive: true })
  writeFileSync(path.join(userDataPath, 'pack-credentials', 'stripe.enc'), value, 'utf8')
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

  it('saves and reads back a key for a business run out of a plain folder', () => {
    // A folder workspace is a supported shape with no repo to name it, so it is
    // named by its own path — and that has to be enough to store a key under.
    const consulting = folderWorkspace('consulting', 'sk_consulting')

    expect(envFor(consulting)).toEqual({ BUILDEX_STRIPE_API_KEY: 'sk_consulting' })
    // Stable: a second resolution of the same folder finds the same key.
    expect(envFor(consulting)).toEqual({ BUILDEX_STRIPE_API_KEY: 'sk_consulting' })
  })

  it('keeps a folder workspace and a repo from sharing a key', () => {
    const consulting = folderWorkspace('consulting', 'sk_consulting')
    const acme = company('acme', 'sk_acme')

    expect(envFor(consulting)).toEqual({ BUILDEX_STRIPE_API_KEY: 'sk_consulting' })
    expect(envFor(acme)).toEqual({ BUILDEX_STRIPE_API_KEY: 'sk_acme' })
  })

  it('gives a PTY with no workspace nothing, and does not even read the shelf', () => {
    preCompanyKey('sk_legacy')

    expect(envFor(undefined)).toEqual({})
    expect(readAppStoreCatalog).not.toHaveBeenCalled()
  })

  it('gives a workspace this machine cannot see nothing, which is what a remote one is', () => {
    // Why: the path names the *remote* filesystem, so nothing local answers for
    // it — and a local folder that happened to share the path would be somebody
    // else's business entirely.
    preCompanyKey('sk_legacy')

    expect(envFor(path.join(dir, 'not-here', 'deep'))).toEqual({})
    expect(readAppStoreCatalog).not.toHaveBeenCalled()
  })

  it('falls back to a pre-company key for a business that has none of its own', () => {
    const acme = company('acme', null)
    preCompanyKey('sk_legacy')

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

describe('companyWorkspacePathForSpawn', () => {
  it('gives a bare shell no workspace, however ordinary its cwd looks', () => {
    // The old rule was "any cwd", so a terminal opened in $HOME received every
    // key on the machine. A shell that belongs to no workspace is nobody's
    // business.
    expect(companyWorkspacePathForSpawn({ cwd: '/Users/dan' })).toBeUndefined()
    expect(companyWorkspacePathForSpawn({})).toBeUndefined()
    expect(companyWorkspacePathForSpawn(undefined)).toBeUndefined()
  })

  it('gives a workspace-owned spawn its cwd, which is where the business is', () => {
    expect(
      companyWorkspacePathForSpawn({ cwd: '/repos/acme', worktreeId: 'repo::/repos/acme' })
    ).toBe('/repos/acme')
  })

  it('has no workspace for a spawn with an id but nowhere to run', () => {
    expect(companyWorkspacePathForSpawn({ worktreeId: 'repo::/repos/acme' })).toBeUndefined()
  })
})
