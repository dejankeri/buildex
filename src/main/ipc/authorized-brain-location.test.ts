import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/types'
import { isPathAllowed } from './filesystem-auth'
import { requireBrainLocation, resolveBrainLocation } from './authorized-brain-location'

let dir = ''
let repoPath = ''
let brainPath = ''
let bindingsFile = ''

// No repos registered: the only way a path can be allowed here is authorization.
function makeStore(repos: Repo[] = []): Store {
  return {
    getRepos: () => repos,
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({})
  } as unknown as Store
}

function bindings(contents: object): void {
  writeFileSync(bindingsFile, JSON.stringify(contents), 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'buildex-brain-auth-'))
  repoPath = path.join(dir, 'api')
  brainPath = path.join(dir, 'brain')
  bindingsFile = path.join(dir, 'brains.json')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(path.join(brainPath, '.git'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('authorized brain location', () => {
  it('lets the renderer read a document under an external brain', () => {
    bindings({ brainByRepo: { [repoPath]: brainPath } })
    const document = path.join(brainPath, 'decisions', 'pricing.md')
    // Why this test exists: the brain moved outside the repo, and fs:readFile
    // denied every document until resolving also authorized the root.
    expect(isPathAllowed(document, makeStore())).toBe(false)

    const location = requireBrainLocation(repoPath, { bindingsFile })

    expect(location?.mode).toBe('external')
    expect(isPathAllowed(document, makeStore())).toBe(true)
  })

  it('authorizes through resolve as well, which is what the placement UI calls', () => {
    bindings({ brainByRepo: { [repoPath]: brainPath } })

    const resolution = resolveBrainLocation(repoPath, { bindingsFile })

    expect(resolution.status).toBe('ready')
    expect(isPathAllowed(path.join(brainPath, 'rules', 'security.md'), makeStore())).toBe(true)
  })

  it('authorizes nothing for an embedded brain', () => {
    bindings({})
    const document = path.join(repoPath, '.buildex', 'decisions', 'pricing.md')

    const location = requireBrainLocation(repoPath, { bindingsFile })

    expect(location?.mode).toBe('embedded')
    // The repo's own root is what allows it in production; widening here would
    // hand out access the embedded path never needed.
    expect(isPathAllowed(document, makeStore())).toBe(false)
  })

  it('authorizes nothing when a pointer has no clone yet', () => {
    mkdirSync(path.join(repoPath, '.buildex'), { recursive: true })
    writeFileSync(
      path.join(repoPath, '.buildex', 'brain.json'),
      JSON.stringify({ remote: 'git@github.com:acme/brain.git' }),
      'utf8'
    )
    bindings({})

    const resolution = resolveBrainLocation(repoPath, { bindingsFile })

    expect(resolution.status).toBe('needs-clone')
    if (resolution.status === 'needs-clone') {
      expect(isPathAllowed(resolution.suggestedPath, makeStore())).toBe(false)
    }
  })
})
