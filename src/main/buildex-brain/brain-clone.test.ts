import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBrainBindings } from './brain-bindings'
import { cloneBrain } from './brain-clone'

let dir = ''
let origin = ''
let bindingsFile = ''

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'buildex-clone-'))
  origin = path.join(dir, 'origin')
  bindingsFile = path.join(dir, 'brains.json')
  execFileSync('git', ['init', '--quiet', origin])
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: origin })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: origin })
  writeFileSync(path.join(origin, 'note.md'), '# Note\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: origin })
  execFileSync('git', ['commit', '--quiet', '-m', 'seed'], { cwd: origin })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('cloneBrain', () => {
  it('clones and remembers where it went', async () => {
    const target = path.join(dir, 'brain')

    const result = await cloneBrain(origin, target, { bindingsFile })

    expect(result.ok).toBe(true)
    expect(existsSync(path.join(target, 'note.md'))).toBe(true)
    expect(readBrainBindings(bindingsFile).clonesByRemote[origin]).toBe(target)
  })

  it('adopts a clone that is already there rather than failing', async () => {
    const target = path.join(dir, 'brain')
    execFileSync('git', ['clone', '--quiet', origin, target])

    const result = await cloneBrain(origin, target, { bindingsFile })

    expect(result.ok).toBe(true)
    expect(readBrainBindings(bindingsFile).clonesByRemote[origin]).toBe(target)
  })

  it('refuses a target that exists and is not a repo', async () => {
    const target = path.join(dir, 'not-a-repo')
    mkdirSync(target, { recursive: true })

    const result = await cloneBrain(origin, target, { bindingsFile })

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(readBrainBindings(bindingsFile).clonesByRemote[origin]).toBeUndefined()
  })

  it('refuses a remote starting with dash and records no binding', async () => {
    const target = path.join(dir, 'brain')
    const maliciousRemote = '--upload-pack=touch /tmp/pwned'

    const result = await cloneBrain(maliciousRemote, target, { bindingsFile })

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(readBrainBindings(bindingsFile).clonesByRemote[maliciousRemote]).toBeUndefined()
  })

  it('refuses a target path starting with dash and records no binding', async () => {
    const maliciousTarget = '-e /tmp/pwned'

    const result = await cloneBrain(origin, maliciousTarget, { bindingsFile })

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(readBrainBindings(bindingsFile).clonesByRemote[origin]).toBeUndefined()
  })
})
