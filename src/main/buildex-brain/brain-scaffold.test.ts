import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRAIN_SECTIONS, scaffoldCompanyBrain } from './brain-scaffold'
import { isBrainInitialized } from './company-brain-scan'
import { embeddedLocation } from './brain-location'

let repo = ''

function location() {
  return embeddedLocation(repo)
}

function read(relativePath: string): string {
  return readFileSync(path.join(repo, '.buildex', relativePath), 'utf8')
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'buildex-scaffold-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('scaffoldCompanyBrain', () => {
  it('gives a new company somewhere to start', () => {
    const result = scaffoldCompanyBrain(location())

    expect(result.created).toContain('strategy/')
    expect(result.created).toContain('decisions/log.md')
    expect(read('strategy/overview.md')).toContain('# Strategy')
  })

  it('creates every declared section', () => {
    scaffoldCompanyBrain(location())

    for (const section of BRAIN_SECTIONS) {
      expect(existsSync(path.join(repo, '.buildex', section.folder))).toBe(true)
    }
  })

  it('seeds reviews, clients and finance with a schedulable automation prompt', () => {
    scaffoldCompanyBrain(location())

    expect(read('reviews/weekly-review.md')).toContain('## Automation prompt')
    expect(read('reviews/weekly-review.md')).toContain('reviews/')
    expect(read('reviews/weekly-review.md')).toContain('decisions/log.md')

    expect(read('clients/triage.md')).toContain('## Automation prompt')
    expect(read('clients/triage.md')).toContain('clients/')

    expect(read('finance/metrics.md')).toContain('## Automation prompt')
    expect(read('finance/metrics.md')).toContain('finance/')
  })

  // Substrings only, never a phrase that spans a line break: these assert what
  // the prompt says, and rewrapping a paragraph must not fail them.
  it('gives capture a home and the distillation pass a prompt to run on it', () => {
    scaffoldCompanyBrain(location())

    const distillation = read('inbox/distillation.md')
    expect(distillation).toContain('## Automation prompt')
    // The routing table lives here and nowhere else — the skill writes the
    // stream, this files it.
    expect(distillation).toContain('decisions/log.md')
    expect(distillation).toContain('rules/operating.md')
    expect(distillation).toContain('Filed <today> → <destination>')
    expect(distillation).toContain('inbox/archive/')
    // Named, not "this one": the prompt is read in the Automations field, where
    // there is no "this file" for it to refer to.
    expect(distillation).toContain('`inbox/distillation.md`')
    expect(distillation).not.toContain('except this one')
    // The valve that makes two agents on two weeks agree: an entry with no home
    // that already exists stays put rather than landing somewhere new each week.
    expect(distillation).toContain('leave the entry where it is')
    expect(distillation).toContain('do not invent a document to hold an entry')
    // A brain in a folder workspace has no git to move a file with.
    expect(distillation).toContain('a plain move when it is not')
  })

  it('lets the pass reach file-per-decision, since nothing else can', () => {
    // The capture skill no longer writes to `decisions/log.md`, so the weekly
    // pass is the only thing that grows it. A prompt that may never create a
    // file leaves the convention beside it dead — exercisable only by hand.
    scaffoldCompanyBrain(location())

    const distillation = read('inbox/distillation.md')
    expect(distillation).toContain('more than twenty `##`')
    expect(distillation).toContain("`decisions/<the entry's date>-<slug>.md`")
    // Derived from the entry, so two weeks cannot produce two names for it —
    // which is why this one exception does not reopen the invention it forbids.
    expect(distillation).toContain('Derive that name from the entry; never choose one.')
    expect(distillation).toContain('description:')
    expect(distillation).toContain('the only file you may create')

    // And the seed beside it names the same threshold and the same shape.
    const log = read('decisions/log.md')
    expect(log).toContain('more than twenty entries')
    expect(log).toContain('decisions/YYYY-MM-DD-<slug>.md')
    expect(log).toContain('weekly distillation pass does exactly this on its own')
  })

  it('files a rule as a rule, not as a dated block above the rules', () => {
    // `rules/operating.md` is the one seeded document whose shape is
    // load-bearing: it is the document the agent is told to follow. A log-shaped
    // insertion wedges a dated block between its heading and its own intro, and
    // does it again every week.
    scaffoldCompanyBrain(location())

    const distillation = read('inbox/distillation.md')
    expect(distillation).toContain('is a list of rules, not a log')
    expect(distillation).toContain('Never paste a dated block into it.')
    // The newest-first rule still applies everywhere it should.
    expect(distillation).toContain('Every other destination is newest first')
  })

  it('states both conventions where an operator will meet them', () => {
    scaffoldCompanyBrain(location())

    // File-per-decision once the log grows — ADR practice, prose not code.
    expect(read('decisions/log.md')).toContain('decisions/YYYY-MM-DD-<slug>.md')
    expect(read('decisions/log.md')).toContain('inbox/')

    // The archive convention, in the rules the agent is told to follow.
    const rules = read('rules/operating.md')
    expect(rules).toContain('inbox/<today>.md')
    expect(rules).toContain('clients/archive/')
    expect(rules).toContain('lowercase')
  })

  it('writes nothing the second time', () => {
    scaffoldCompanyBrain(location())

    expect(scaffoldCompanyBrain(location()).created).toEqual([])
  })

  it('never touches a section the company has already written in', () => {
    mkdirSync(path.join(repo, '.buildex', 'strategy'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'strategy', 'ours.md'), '# Ours\n', 'utf8')

    scaffoldCompanyBrain(location())

    // The seed must not appear beside their file, and theirs must survive.
    expect(existsSync(path.join(repo, '.buildex', 'strategy', 'overview.md'))).toBe(false)
    expect(read('strategy/ours.md')).toBe('# Ours\n')
  })

  it('leaves an edited seed alone', () => {
    scaffoldCompanyBrain(location())
    writeFileSync(path.join(repo, '.buildex', 'strategy', 'overview.md'), '# Rewritten\n', 'utf8')

    scaffoldCompanyBrain(location())

    expect(read('strategy/overview.md')).toBe('# Rewritten\n')
  })

  it('creates only the sections that were chosen, plus the one capture needs', () => {
    scaffoldCompanyBrain(location(), { folders: ['strategy', 'decisions'] })

    expect(existsSync(path.join(repo, '.buildex', 'strategy'))).toBe(true)
    expect(existsSync(path.join(repo, '.buildex', 'decisions'))).toBe(true)
    expect(existsSync(path.join(repo, '.buildex', 'finance'))).toBe(false)
  })

  it('gives the capture skill its destination even when inbox was declined', () => {
    // The skill is seeded whatever the operator picked, and its one destination
    // is `inbox/`. Declining the section used to be harmless, because the skill
    // carried its own routing table; that table now lives in the inbox seed, so
    // an unchosen inbox would leave a skill writing to nowhere and no copy of
    // the convention anywhere in the brain.
    const result = scaffoldCompanyBrain(location(), { folders: ['finance'] })

    expect(result.created).toContain('inbox/distillation.md')
    expect(read('inbox/distillation.md')).toContain('## Automation prompt')
    expect(
      readFileSync(path.join(repo, '.buildex', 'skills', 'record-decision', 'SKILL.md'), 'utf8')
    ).toContain('`inbox/<today>.md`')
  })

  it("answers the seed's opening question with what the operator typed", () => {
    scaffoldCompanyBrain(location(), {
      folders: ['strategy'],
      summary: 'We help fitness coaches run their business.'
    })

    const overview = read('strategy/overview.md')
    expect(overview).toContain('We help fitness coaches run their business.')
    // Why: substituted, not appended — the document must not carry both the
    // question and its answer.
    expect(overview).not.toContain('One paragraph a stranger would understand')
  })

  it('leaves the question in place when nothing was typed', () => {
    scaffoldCompanyBrain(location(), { folders: ['strategy'], summary: '   ' })

    expect(read('strategy/overview.md')).toContain('One paragraph a stranger would understand')
  })

  it('puts the summary nowhere but the document that asked for it', () => {
    scaffoldCompanyBrain(location(), {
      folders: ['strategy', 'decisions'],
      summary: 'A coaching studio.'
    })

    expect(read('decisions/log.md')).not.toContain('A coaching studio.')
  })
})

describe('isBrainInitialized', () => {
  it('is false for a repo BuildEx has never touched', () => {
    expect(isBrainInitialized(location())).toBe(false)
  })

  it('is true once the operator has set sections up', () => {
    scaffoldCompanyBrain(location(), { folders: ['strategy'] })

    expect(isBrainInitialized(location())).toBe(true)
  })

  it('stays false when the only thing there is a skill the Store installed', () => {
    // Why: an older BuildEx installed apps by writing their skills into
    // `.buildex/`, and those repos still exist. If that counted as a brain, the
    // operator would never be offered setup and would be left with a brain that
    // is nothing but somebody else's skills.
    mkdirSync(path.join(repo, '.buildex', 'skills', 'slack-search'), { recursive: true })

    expect(isBrainInitialized(location())).toBe(false)
  })

  it('stays false for a repo that has only a gate preset', () => {
    // The agent's permission policy is policy, not company knowledge — the
    // same mistake `.buildex/gate-applied.json` already caused, where its
    // presence alone meant setup was never offered again.
    mkdirSync(path.join(repo, '.buildex'), { recursive: true })
    writeFileSync(path.join(repo, '.buildex', 'gate-preset.json'), '{"deny":[]}', 'utf8')

    expect(isBrainInitialized(location())).toBe(false)
  })
})

describe('an external brain', () => {
  it('scaffolds into the brain repo, not the code repo', () => {
    const brain = mkdtempSync(path.join(tmpdir(), 'buildex-external-'))
    try {
      const external = { root: brain, gitRoot: brain, pathspec: '.', mode: 'external' as const }

      scaffoldCompanyBrain(external, { folders: ['strategy'] })

      expect(existsSync(path.join(brain, 'strategy', 'overview.md'))).toBe(true)
      // The code repo is untouched: no `.buildex/` appears beside the code.
      expect(existsSync(path.join(repo, '.buildex'))).toBe(false)
      expect(isBrainInitialized(external)).toBe(true)
    } finally {
      rmSync(brain, { recursive: true, force: true })
    }
  })
})
