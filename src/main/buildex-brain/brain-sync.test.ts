import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { embeddedLocation, externalLocation } from './brain-location'
import { pullBrain, pushBrain, reportPush } from './brain-sync'
import { saveBrain } from './brain-history'

let dir = ''
let origin = ''
let brain = ''

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function commitFile(cwd: string, name: string, body: string): void {
  writeFileSync(path.join(cwd, name), body, 'utf8')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '--quiet', '-m', name)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'buildex-sync-'))
  origin = path.join(dir, 'origin.git')
  brain = path.join(dir, 'brain')
  execFileSync('git', ['init', '--quiet', '--bare', origin])
  execFileSync('git', ['clone', '--quiet', origin, brain])
  git(brain, 'config', 'user.email', 'test@example.com')
  git(brain, 'config', 'user.name', 'Test')
  commitFile(brain, 'seed.md', '# Seed\n')
  git(brain, 'push', '--quiet', '-u', 'origin', 'HEAD')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('pushBrain', () => {
  it('never pushes an embedded brain, because that repo is the company code', async () => {
    // The single most consequential rule in this feature: a Save button that
    // pushes somebody's code repo is not something we ship.
    const result = await pushBrain(embeddedLocation(brain))

    expect(result).toEqual({ pushed: false, reason: 'embedded' })
    // And nothing reached the remote as a side effect.
    const remoteLog = execFileSync('git', ['log', '--oneline'], { cwd: origin, encoding: 'utf8' })
    expect(remoteLog.trim().split('\n')).toHaveLength(1)
  })

  it('pushes an external brain to its remote', async () => {
    commitFile(brain, 'pricing.md', '# Pricing\n')

    expect(await pushBrain(externalLocation(brain))).toEqual({ pushed: true })

    const remoteLog = execFileSync('git', ['log', '--oneline'], { cwd: origin, encoding: 'utf8' })
    expect(remoteLog).toContain('pricing.md')
  })

  it('reports a brain with no upstream instead of failing the save', async () => {
    const lone = path.join(dir, 'lone')
    execFileSync('git', ['init', '--quiet', lone])
    git(lone, 'config', 'user.email', 'test@example.com')
    git(lone, 'config', 'user.name', 'Test')
    commitFile(lone, 'note.md', '# Note\n')

    expect(await pushBrain(externalLocation(lone))).toEqual({
      pushed: false,
      reason: 'no-upstream'
    })
  })
})

describe('reportPush', () => {
  // The one place that decides what a push that did not happen means, so no
  // caller downstream has to match on a reason string.
  it('separates having nowhere to push from having failed to push', () => {
    expect(reportPush({ pushed: true })).toEqual({ pushed: true })
    expect(reportPush({ pushed: false, reason: 'no-upstream' })).toEqual({
      pushed: false,
      localOnly: true
    })
    expect(reportPush({ pushed: false, reason: 'embedded' })).toEqual({
      pushed: false,
      localOnly: true
    })
    expect(reportPush({ pushed: false, reason: 'failed', error: 'host unreachable' })).toEqual({
      pushed: false,
      error: 'host unreachable'
    })
  })
})

describe('saveBrain', () => {
  it('keeps the commit when the push cannot land', async () => {
    // An unreachable remote must never cost the operator their writing.
    git(brain, 'remote', 'set-url', 'origin', path.join(dir, 'nowhere.git'))
    writeFileSync(path.join(brain, 'strategy.md'), '# Strategy\n', 'utf8')

    const result = await saveBrain(externalLocation(brain), 'A decision')

    expect(result.ok).toBe(true)
    expect(result.savedPaths).toEqual(['strategy.md'])
    expect(result.pushed).toBe(false)
    expect(result.pushError).toBeTruthy()

    const log = execFileSync('git', ['log', '--oneline'], { cwd: brain, encoding: 'utf8' })
    expect(log).toContain('A decision')
  })

  it('calls a brain with no remote local-only, not a failed push', async () => {
    // A brain repo with no remote is a supported setup, not a broken one: the
    // save must not read as a warning the operator can act on, because there is
    // nothing there to retry.
    const lone = path.join(dir, 'lone-save')
    execFileSync('git', ['init', '--quiet', lone])
    git(lone, 'config', 'user.email', 'test@example.com')
    git(lone, 'config', 'user.name', 'Test')
    commitFile(lone, 'note.md', '# Note\n')
    writeFileSync(path.join(lone, 'strategy.md'), '# Strategy\n', 'utf8')

    const result = await saveBrain(externalLocation(lone), 'A decision')

    expect(result.ok).toBe(true)
    expect(result.pushed).toBe(false)
    expect(result.localOnly).toBe(true)
    expect(result.pushError).toBeUndefined()
  })
})

describe('pullBrain', () => {
  it('fast-forwards a brain a teammate has moved on', async () => {
    const other = path.join(dir, 'other')
    execFileSync('git', ['clone', '--quiet', origin, other])
    git(other, 'config', 'user.email', 'other@example.com')
    git(other, 'config', 'user.name', 'Other')
    commitFile(other, 'from-teammate.md', '# Theirs\n')
    git(other, 'push', '--quiet')

    expect(await pullBrain(externalLocation(brain))).toEqual({ pulled: true, diverged: false })

    const log = execFileSync('git', ['log', '--oneline'], { cwd: brain, encoding: 'utf8' })
    expect(log).toContain('from-teammate.md')
  })

  it('reports divergence rather than merging the company two ways', async () => {
    const other = path.join(dir, 'other')
    execFileSync('git', ['clone', '--quiet', origin, other])
    git(other, 'config', 'user.email', 'other@example.com')
    git(other, 'config', 'user.name', 'Other')
    commitFile(other, 'theirs.md', '# Theirs\n')
    git(other, 'push', '--quiet')
    commitFile(brain, 'ours.md', '# Ours\n')

    const result = await pullBrain(externalLocation(brain))

    expect(result.pulled).toBe(false)
    expect(result.diverged).toBe(true)
    // Ours is still here, untouched and unmerged.
    const log = execFileSync('git', ['log', '--oneline'], { cwd: brain, encoding: 'utf8' })
    expect(log).toContain('ours.md')
    expect(log).not.toContain('theirs.md')
  })

  it('does nothing at all in embedded mode', async () => {
    expect(await pullBrain(embeddedLocation(brain))).toEqual({ pulled: false, diverged: false })
  })
})
