import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyExcludeBlock, ensureBuildExGitExclude } from './repo-git-exclude'

let repoPath = ''

function readExclude(): string {
  return readFileSync(path.join(repoPath, '.git', 'info', 'exclude'), 'utf8')
}

/** What git will actually refuse to stage — the only claim worth making here. */
function isIgnored(relativePath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', relativePath], { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

function writeRepoFile(relativePath: string, contents: string): void {
  const absolute = path.join(repoPath, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

beforeEach(() => {
  repoPath = mkdtempSync(path.join(tmpdir(), 'buildex-git-exclude-'))
  execFileSync('git', ['init', '--quiet'], { cwd: repoPath })
})

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true })
})

describe('applyExcludeBlock', () => {
  it('leaves what the operator excluded by hand alone', () => {
    const current = '# mine\n.env.local\n'

    const next = applyExcludeBlock(current, ['.claude/CLAUDE.md'])

    expect(next).toContain('# mine\n.env.local\n')
    expect(next).toContain('.claude/CLAUDE.md')
  })

  it('replaces only the span between the markers', () => {
    const first = applyExcludeBlock('.env.local\n', ['.claude/CLAUDE.md'])

    const second = applyExcludeBlock(first, ['.claude/gate-applied.json'])

    expect(second).toContain('.env.local')
    expect(second).toContain('.claude/gate-applied.json')
    expect(second).not.toContain('.claude/CLAUDE.md')
  })
})

describe('ensureBuildExGitExclude', () => {
  it('hides the files BuildEx generates', () => {
    writeRepoFile('.claude/company-context.md', '# Company\n')
    writeRepoFile('.claude/CLAUDE.md', '@./company-context.md\n')
    writeRepoFile('.claude/gate-applied.json', '{}\n')
    writeRepoFile('.claude/settings.local.json', '{}\n')

    ensureBuildExGitExclude(repoPath)

    expect(isIgnored('.claude/company-context.md')).toBe(true)
    expect(isIgnored('.claude/CLAUDE.md')).toBe(true)
    expect(isIgnored('.claude/gate-applied.json')).toBe(true)
    expect(isIgnored('.claude/settings.local.json')).toBe(true)
  })

  it('leaves the operator their own work in the same directory', () => {
    // The regression this exists for: excluding `.claude/` wholesale hid every
    // one of these, and hid them silently — a skill written afterwards was
    // unstageable, so it worked on one machine and existed on no other.
    writeRepoFile('.claude/skills/deploy-api/SKILL.md', '# Deploy\n')
    writeRepoFile('.claude/skills/deploy-api/scripts/deploy.sh', '#!/bin/sh\n')
    writeRepoFile('.claude/hooks/check-gstack.sh', '#!/bin/sh\n')
    writeRepoFile('.claude/agents/content-drafter.md', '# Drafter\n')

    ensureBuildExGitExclude(repoPath)

    expect(isIgnored('.claude/skills/deploy-api/SKILL.md')).toBe(false)
    expect(isIgnored('.claude/skills/deploy-api/scripts/deploy.sh')).toBe(false)
    expect(isIgnored('.claude/hooks/check-gstack.sh')).toBe(false)
    expect(isIgnored('.claude/agents/content-drafter.md')).toBe(false)
  })

  it('keeps settings.json visible, because the gate in it is policy someone reviews', () => {
    writeRepoFile('.claude/settings.json', '{"permissions":{"allow":["Read"]}}\n')

    ensureBuildExGitExclude(repoPath)

    expect(isIgnored('.claude/settings.json')).toBe(false)
  })

  it('hides a brain-skill link but not a skill of the same shape written by hand', () => {
    mkdirSync(path.join(repoPath, '.buildex', 'skills', 'capture-decision'), { recursive: true })
    mkdirSync(path.join(repoPath, '.claude', 'skills'), { recursive: true })
    symlinkSync(
      path.join('..', '..', '.buildex', 'skills', 'capture-decision'),
      path.join(repoPath, '.claude', 'skills', 'capture-decision'),
      'dir'
    )
    writeRepoFile('.claude/skills/mcp-qa/SKILL.md', '# QA\n')

    ensureBuildExGitExclude(repoPath)

    expect(isIgnored('.claude/skills/capture-decision')).toBe(true)
    expect(isIgnored('.claude/skills/mcp-qa/SKILL.md')).toBe(false)
  })

  it('drops a link from the block once the brain no longer has that skill', () => {
    const link = path.join(repoPath, '.claude', 'skills', 'retired')
    mkdirSync(path.join(repoPath, '.buildex', 'skills', 'retired'), { recursive: true })
    mkdirSync(path.join(repoPath, '.claude', 'skills'), { recursive: true })
    symlinkSync(path.join('..', '..', '.buildex', 'skills', 'retired'), link, 'dir')
    ensureBuildExGitExclude(repoPath)
    expect(readExclude()).toContain('.claude/skills/retired')

    // unlink, not rm — `skill-link.ts` prunes links the same way, and for the
    // same reason: rmSync no-ops on a symlink whose target is already gone.
    rmSync(path.join(repoPath, '.buildex', 'skills', 'retired'), { recursive: true })
    unlinkSync(link)
    ensureBuildExGitExclude(repoPath)

    expect(readExclude()).not.toContain('.claude/skills/retired')
  })

  it('reports no change on a second run, so opening a repo twice is free', () => {
    writeRepoFile('.claude/company-context.md', '# Company\n')

    expect(ensureBuildExGitExclude(repoPath)).toBe(true)
    expect(ensureBuildExGitExclude(repoPath)).toBe(false)
  })

  it('is a no-op for a plain folder with no git to keep clean', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'buildex-no-git-'))
    try {
      expect(ensureBuildExGitExclude(folder)).toBe(false)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
