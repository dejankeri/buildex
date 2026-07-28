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
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { embeddedLocation, externalLocation } from '../buildex-brain/brain-location'
import {
  linkSkillIntoAgentDir,
  relinkBrainSkills,
  skillsRoot,
  unlinkBrainSkills
} from './skill-link'

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
      needsCopy: [],
      pruned: []
    })
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
