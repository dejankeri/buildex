import { describe, expect, it } from 'vitest'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { BrainFolder, BrainSectionInfo } from '../../../../shared/buildex-brain-types'
import { brainPlacement, countFilledSections, latestRunForRepo } from './portfolio-row'

// The arithmetic behind the five columns. Every one of these is a claim the
// dashboard makes about a business the operator is not currently looking at,
// which is the whole reason to check it here rather than by eye.

const SECTIONS: BrainSectionInfo[] = [
  { folder: 'strategy', title: 'Strategy', purpose: '' },
  { folder: 'decisions', title: 'Decisions', purpose: '' },
  { folder: 'finance', title: 'Finance', purpose: '' }
]

function folders(...entries: [string, number][]): BrainFolder[] {
  return entries.map(([path, documentCount]) => ({ path, documentCount }))
}

function automation(id: string, repoId: string, name: string): Automation {
  return { id, name, projectId: repoId } as Automation
}

function run(automationId: string, startedAt: number | null, createdAt: number): AutomationRun {
  return {
    id: `${automationId}-${createdAt}`,
    automationId,
    startedAt,
    dispatchedAt: null,
    createdAt,
    scheduledFor: createdAt + 1_000_000,
    status: 'completed'
  } as AutomationRun
}

describe('countFilledSections', () => {
  it('counts a section that holds documents only in a subfolder', () => {
    // A company filing decisions by year still has a filled Decisions section;
    // matching the folder path exactly would call it empty.
    expect(countFilledSections(folders(['decisions/2026', 2]), SECTIONS)).toBe(1)
  })

  it('ignores folders that hold nothing and folders outside every section', () => {
    expect(
      countFilledSections(folders(['strategy', 0], ['scratch', 5], ['finance', 1]), SECTIONS)
    ).toBe(1)
  })

  it('does not let a sibling folder claim a section by prefix', () => {
    expect(countFilledSections(folders(['financials', 3]), SECTIONS)).toBe(0)
  })
})

describe('brainPlacement', () => {
  it('separates a shared brain from one that simply lives in its own repo', () => {
    const own = { root: '/brains/acme', gitRoot: '/brains/acme', pathspec: '.', mode: 'external' }
    expect(brainPlacement({ status: 'ready', location: { ...own } as never })).toBe('separate-repo')
    expect(
      brainPlacement({ status: 'ready', location: { ...own, remote: 'git@host:acme' } as never })
    ).toBe('shared')
  })

  it('reports a brain this machine cannot use', () => {
    expect(
      brainPlacement({ status: 'needs-clone', remote: 'git@host:acme', suggestedPath: '/tmp/a' })
    ).toBe('not-cloned')
    expect(brainPlacement({ status: 'broken', reason: 'missing', path: '/gone' })).toBe('missing')
    expect(brainPlacement({ status: 'broken', reason: 'not-a-repo', path: '/dir' })).toBe(
      'not-a-repo'
    )
  })

  it('has nothing to say about a repo that was never resolved', () => {
    expect(brainPlacement(null)).toBeNull()
  })
})

describe('latestRunForRepo', () => {
  const automations = [
    automation('a1', 'repo-1', 'Weekly distillation'),
    automation('a2', 'repo-2', 'Other')
  ]

  it('takes the most recent run of this business and names its automation', () => {
    const latest = latestRunForRepo('repo-1', automations, [
      run('a1', 100, 90),
      run('a1', 300, 290),
      run('a2', 900, 890)
    ])
    expect(latest).toEqual({ at: 300, status: 'completed', automationName: 'Weekly distillation' })
  })

  it('ranks by when a run happened, never by when it was scheduled', () => {
    // A queued run's scheduledFor is in the future; ranking on it would let a
    // run that has not happened claim to be the last one that did.
    const latest = latestRunForRepo('repo-1', automations, [
      run('a1', 500, 400),
      run('a1', null, 450)
    ])
    expect(latest?.at).toBe(500)
  })

  it('is null for a business with no automations at all', () => {
    expect(latestRunForRepo('repo-3', automations, [run('a1', 100, 90)])).toBeNull()
  })
})
