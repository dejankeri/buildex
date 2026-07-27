import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bindRepoToBrain,
  readBrainBindings,
  rememberClone,
  setDefaultBrain,
  unbindRepo
} from './brain-bindings'

let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'buildex-bindings-'))
  file = path.join(dir, 'brains.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('brain bindings', () => {
  it('reads as empty before anything is bound', () => {
    expect(readBrainBindings(file)).toEqual({ clonesByRemote: {}, brainByRepo: {} })
  })

  it('remembers which brain a repo uses', () => {
    bindRepoToBrain('/code/api', '/brains/acme', file)

    expect(readBrainBindings(file).brainByRepo['/code/api']).toBe('/brains/acme')
  })

  it('forgets a repo without disturbing the others', () => {
    bindRepoToBrain('/code/api', '/brains/acme', file)
    bindRepoToBrain('/code/web', '/brains/acme', file)

    unbindRepo('/code/api', file)

    expect(readBrainBindings(file).brainByRepo).toEqual({ '/code/web': '/brains/acme' })
  })

  it('remembers where a remote was cloned on this machine', () => {
    rememberClone('git@github.com:acme/brain.git', '/brains/acme', file)

    expect(readBrainBindings(file).clonesByRemote['git@github.com:acme/brain.git']).toBe(
      '/brains/acme'
    )
  })

  it('clears the default brain when set to null', () => {
    setDefaultBrain('/brains/acme', file)
    setDefaultBrain(null, file)

    expect(readBrainBindings(file).defaultBrainPath).toBeUndefined()
  })

  it('returns safe defaults when JSON is invalid', () => {
    writeFileSync(file, '{not json', 'utf8')

    expect(readBrainBindings(file)).toEqual({ clonesByRemote: {}, brainByRepo: {} })
  })

  it('ignores malformed fields while preserving valid ones', () => {
    writeFileSync(
      file,
      JSON.stringify({ clonesByRemote: 5, brainByRepo: { '/code/api': '/brains/acme' } }),
      'utf8'
    )

    expect(readBrainBindings(file)).toEqual({
      clonesByRemote: {},
      brainByRepo: { '/code/api': '/brains/acme' }
    })
  })

  it('reads as empty rather than throwing with no argument outside Electron', () => {
    // brainBindingsFile() needs app.getPath('userData'), unavailable in this test
    // process — a machine with no reachable bindings file has no bindings.
    expect(readBrainBindings()).toEqual({ clonesByRemote: {}, brainByRepo: {} })
  })
})
