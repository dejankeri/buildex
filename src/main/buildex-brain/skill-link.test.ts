import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeFs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { embeddedLocation, externalLocation } from './brain-location'
import {
  copySkillIntoAgentDir,
  linkSkillIntoAgentDir,
  relinkBrainSkills,
  skillsRoot,
  unlinkBrainSkills
} from './skill-link'

// Windows without developer mode, simulated where it can be: an unprivileged
// process there gets EPERM from every symlink call, and nothing in skill-link
// reads `process.platform`, so failing the call IS the platform difference.
const { fsMockState } = vi.hoisted(() => ({ fsMockState: { symlinksUnavailable: false } }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    default: actual,
    symlinkSync: (...args: Parameters<typeof actual.symlinkSync>) => {
      if (fsMockState.symlinksUnavailable) {
        throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' })
      }
      return actual.symlinkSync(...args)
    }
  }
})

let dir = ''
let repo = ''
let brain = ''

function writeSkill(root: string, name: string): void {
  const directory = path.join(root, 'skills', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'SKILL.md'), `# ${name}\n`, 'utf8')
}

function agentSkill(name: string): string {
  return path.join(repo, '.claude', 'skills', name)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'buildex-skill-link-'))
  repo = path.join(dir, 'api')
  brain = path.join(dir, 'acme-brain')
  mkdirSync(repo, { recursive: true })
  mkdirSync(brain, { recursive: true })
})

afterEach(() => {
  fsMockState.symlinksUnavailable = false
  rmSync(dir, { recursive: true, force: true })
})

describe('linkSkillIntoAgentDir', () => {
  it('replaces a link that resolves nowhere instead of refusing forever', () => {
    // Exactly what a migration leaves behind: the relative link an embedded
    // brain got, pointing at a `.buildex/` that has gone.
    mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true })
    symlinkSync(
      path.join('..', '..', '.buildex', 'skills', 'slack-search'),
      agentSkill('slack-search'),
      'dir'
    )
    writeSkill(brain, 'slack-search')

    // Was 'needs-copy' — a dangling link is invisible to existsSync, so the
    // symlink call threw EEXIST and every later install failed the same way.
    expect(linkSkillIntoAgentDir(repo, externalLocation(brain), 'slack-search')).toBe('linked')
    expect(realpathSync(agentSkill('slack-search'))).toBe(
      realpathSync(path.join(brain, 'skills', 'slack-search'))
    )
  })

  it('still refuses a real directory somebody put there by hand', () => {
    mkdirSync(agentSkill('ours'), { recursive: true })
    writeFileSync(path.join(agentSkill('ours'), 'SKILL.md'), '# Ours\n', 'utf8')
    writeSkill(brain, 'ours')

    expect(linkSkillIntoAgentDir(repo, externalLocation(brain), 'ours')).toBe('needs-copy')
    expect(readFileSync(path.join(agentSkill('ours'), 'SKILL.md'), 'utf8')).toBe('# Ours\n')
  })
})

describe('relinkBrainSkills', () => {
  it('links every skill in the brain, whoever wrote it', () => {
    writeSkill(brain, 'slack-search')
    writeSkill(brain, 'how-we-price')

    const result = relinkBrainSkills(repo, externalLocation(brain))

    expect(result.linked).toEqual(['how-we-price', 'slack-search'])
    for (const name of ['how-we-price', 'slack-search']) {
      expect(realpathSync(agentSkill(name))).toBe(realpathSync(path.join(brain, 'skills', name)))
    }
  })

  it('drops a link left over from the brain that used to be here', () => {
    mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true })
    symlinkSync(path.join(repo, '.buildex', 'skills', 'gone'), agentSkill('gone'), 'dir')
    writeSkill(brain, 'slack-search')

    const result = relinkBrainSkills(repo, externalLocation(brain))

    expect(result.pruned).toEqual(['gone'])
    expect(existsSync(path.join(repo, '.claude', 'skills', 'gone'))).toBe(false)
  })

  it('has nothing to do for a brain with no skills', () => {
    expect(relinkBrainSkills(repo, embeddedLocation(repo))).toEqual({
      linked: [],
      copied: [],
      unavailable: [],
      pruned: []
    })
  })
})

describe('a machine that cannot symlink', () => {
  beforeEach(() => {
    fsMockState.symlinksUnavailable = true
  })

  it('copies the skill in, so the agent loads it at all', () => {
    writeSkill(brain, 'how-we-price')
    mkdirSync(path.join(brain, 'skills', 'how-we-price', 'reference'), { recursive: true })
    writeFileSync(
      path.join(brain, 'skills', 'how-we-price', 'reference', 'tiers.md'),
      '# Tiers\n',
      'utf8'
    )

    const result = relinkBrainSkills(repo, externalLocation(brain))

    expect(result).toEqual({
      linked: [],
      copied: ['how-we-price'],
      unavailable: [],
      pruned: []
    })
    // Real files at the path the agent runtime reads, not a link it cannot follow.
    expect(lstatSync(agentSkill('how-we-price')).isSymbolicLink()).toBe(false)
    expect(readFileSync(path.join(agentSkill('how-we-price'), 'SKILL.md'), 'utf8')).toBe(
      '# how-we-price\n'
    )
    expect(
      readFileSync(path.join(agentSkill('how-we-price'), 'reference', 'tiers.md'), 'utf8')
    ).toBe('# Tiers\n')
  })

  it('leaves the copy alone on the next sync rather than rewriting it', () => {
    writeSkill(brain, 'how-we-price')
    relinkBrainSkills(repo, externalLocation(brain))
    writeFileSync(path.join(agentSkill('how-we-price'), 'NOTES.md'), '# Local\n', 'utf8')

    const result = relinkBrainSkills(repo, externalLocation(brain))

    expect(result.copied).toEqual([])
    expect(result.unavailable).toEqual(['how-we-price'])
    expect(readFileSync(path.join(agentSkill('how-we-price'), 'NOTES.md'), 'utf8')).toBe(
      '# Local\n'
    )
  })

  it('never copies over a skill the operator wrote by hand', () => {
    mkdirSync(agentSkill('ours'), { recursive: true })
    writeFileSync(path.join(agentSkill('ours'), 'SKILL.md'), '# Ours\n', 'utf8')
    writeSkill(brain, 'ours')

    expect(copySkillIntoAgentDir(repo, externalLocation(brain), 'ours')).toBe('occupied')
    expect(readFileSync(path.join(agentSkill('ours'), 'SKILL.md'), 'utf8')).toBe('# Ours\n')
  })

  it('refuses to write through a link it could not remove', () => {
    mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true })
    // The link has to pre-date the failure, the way a checkout that moved
    // between machines does — so it is written while symlinks still work.
    fsMockState.symlinksUnavailable = false
    symlinkSync(path.join(brain, 'skills', 'gone'), agentSkill('dangling'), 'dir')
    fsMockState.symlinksUnavailable = true
    writeSkill(brain, 'dangling')

    // Copying onto a symlink writes through it — here, straight into the brain.
    expect(copySkillIntoAgentDir(repo, externalLocation(brain), 'dangling')).toBe('failed')
  })
})

describe('unlinkBrainSkills', () => {
  it('removes live links into this brain and leaves everything else', () => {
    writeSkill(brain, 'slack-search')
    const other = path.join(dir, 'other-brain')
    writeSkill(other, 'someone-elses')
    relinkBrainSkills(repo, externalLocation(brain))
    symlinkSync(path.join(other, 'skills', 'someone-elses'), agentSkill('someone-elses'), 'dir')
    mkdirSync(agentSkill('hand-written'), { recursive: true })

    expect(unlinkBrainSkills(repo, externalLocation(brain))).toEqual(['slack-search'])

    // The brain itself keeps its skill — this unlinks, it does not delete.
    expect(existsSync(path.join(skillsRoot(externalLocation(brain)), 'slack-search'))).toBe(true)
    expect(existsSync(agentSkill('slack-search'))).toBe(false)
    expect(lstatSync(agentSkill('someone-elses')).isSymbolicLink()).toBe(true)
    expect(existsSync(agentSkill('hand-written'))).toBe(true)
  })
})
