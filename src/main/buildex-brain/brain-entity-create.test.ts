import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrainLocation } from '../../shared/buildex-brain-types'
import { createBrainEntity } from './brain-entity-create'

let dir = ''
let location: BrainLocation

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'buildex-entity-'))
  mkdirSync(path.join(dir, 'clients'), { recursive: true })
  location = { root: dir, gitRoot: dir, pathspec: '.', mode: 'external' }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createBrainEntity', () => {
  it('creates the folder and the main file that marks it an entity', () => {
    const result = createBrainEntity(location, 'clients', 'Acme Corp')

    expect(result.ok).toBe(true)
    expect(result.entityPath).toBe('clients/acme-corp')
    expect(result.documentId).toBe('clients/acme-corp/index.md')
    expect(readFileSync(path.join(dir, 'clients', 'acme-corp', 'index.md'), 'utf8')).toBe(
      '# Acme Corp\n\n'
    )
  })

  it('slugs the title the same way a document would', () => {
    expect(createBrainEntity(location, 'clients', 'Ac/me  Corp!').entityPath).toBe(
      'clients/ac-me-corp'
    )
  })

  it('refuses a name that slugs to nothing', () => {
    const result = createBrainEntity(location, 'clients', '///')

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('refuses a folder that is already taken', () => {
    mkdirSync(path.join(dir, 'clients', 'acme'), { recursive: true })

    const result = createBrainEntity(location, 'clients', 'Acme')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Already exists')
  })

  it('creates one inside another entity, which is what a nested account needs', () => {
    mkdirSync(path.join(dir, 'clients', 'acme'), { recursive: true })

    const result = createBrainEntity(location, 'clients/acme', 'EMEA')

    expect(result.ok).toBe(true)
    expect(result.entityPath).toBe('clients/acme/emea')
  })

  it('refuses a parent outside the brain, however it is spelled', () => {
    for (const parent of ['..', '../escape', 'clients/../../escape', '/etc']) {
      const result = createBrainEntity(location, parent, 'Acme')

      expect(result.ok).toBe(false)
      expect(existsSync(path.join(dir, '..', 'escape'))).toBe(false)
    }
  })

  it('refuses a parent folder that does not exist', () => {
    const result = createBrainEntity(location, 'nowhere', 'Acme')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('No such folder')
  })
})
