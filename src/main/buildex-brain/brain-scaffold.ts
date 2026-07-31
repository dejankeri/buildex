import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrainLocation } from '../../shared/buildex-brain-types'
import { seedCaptureSkill } from './capture-skill-seed'

// The shape a new company brain starts in.
//
// Not invented here: these are the areas BuildEx's own conventions already name
// — strategy, clients, finance, people, product, content, decisions, reviews.
// The point is that nobody starts from a blank page, and that two companies'
// brains are legible to each other and to the agent.
//
// Every seeded file is a real, editable prompt rather than a placeholder. An
// empty file teaches nothing; a file that asks the right question gets answered.
//
// inbox/, reviews/, clients/ and finance/ also seed a ready-to-paste automation
// prompt. The scheduler is Orca's own — cron/RRULE, disposable per-run worktrees,
// run history — this fork only points it at a document the company already has.
//
// inbox/ is the one that closes the loop. Capture and filing are separate jobs:
// the `record-decision` skill appends to today's inbox file mid-session, and the
// weekly distillation pass is what moves each entry into the section that owns
// it. An agent asked to choose a destination while work is happening chooses a
// different one each night; an agent asked only to write it down does not.
//
// Written only when the operator asks for it. An earlier version ran this on the
// first touch of any BuildEx surface, which meant opening the Store wrote nine
// folders into a repo somebody had only wanted to browse apps from.

export type BrainSection = {
  /** Folder under `.buildex/`, or '' for the brain root. */
  folder: string
  title: string
  /** One line the UI shows under the section heading. */
  purpose: string
  /** Seed document, written only when the section is empty. */
  seed?: {
    name: string
    body: string
    /**
     * The exact placeholder the operator's own one-line answer replaces, when
     * they give one at setup. Turns the first screen from a form into the first
     * sentence of the brain.
     */
    summarySlot?: string
  }
}

export const BRAIN_SECTIONS: BrainSection[] = [
  {
    folder: 'inbox',
    title: 'Inbox',
    purpose: 'Captured mid-session, before anyone decided where it belongs. Emptied weekly.',
    seed: {
      name: 'distillation.md',
      body: `# Inbox

Where the agent writes things down while work is happening, so nothing waits on
somebody deciding which document it belongs in. One file per day, named
\`YYYY-MM-DD.md\`, newest entry first inside it. This file is not one of them.

Capturing is not filing. An entry stays here until the weekly pass below copies
it into the section that owns it and marks it \`Filed\`; a day whose entries are
all filed moves to \`inbox/archive/\`. Nothing here is ever deleted, and nothing
here is ever rewritten after it is written.

The \`record-decision\` skill writes here and nowhere else. Read it before adding
an entry by hand, so what you write reads like the rest.

## Automation prompt

Schedule as a **Weekly** automation against this repo (sidebar \`Automations\`
→ the \`+\`). Paste the prompt below and pick a day and time. Until it is
scheduled, everything captured stays in the inbox — visible, but unfiled.

> Distill the company brain's inbox. Read every \`inbox/*.md\` file except
> \`inbox/distillation.md\`, oldest file first, and every entry in a file top to
> bottom. Do not read or change anything under \`inbox/archive/\`.
>
> For each entry not already marked \`Filed\`, in order:
>
> 1. Choose its destination by this table and nothing else. A call that could
>    have gone another way goes to \`decisions/log.md\`. Something about how this
>    company works goes to \`rules/operating.md\`. Anything else goes to the
>    single most specific document that **already exists** for what the entry is
>    about — a named client's own document before the \`clients/\` overview,
>    \`finance/metrics.md\` before anything broader. If no document that exists
>    covers it, leave the entry where it is and go to the next one. Do not create
>    a document to hold an entry. An entry left in the inbox is not a mistake; a
>    misfiled one is.
> 2. Copy the entry into that document directly under its \`#\` heading, above
>    what is already there — at the top of the file if it has no \`#\` heading —
>    keeping the entry's original date and its exact words. Change nothing that
>    was already in that document.
> 3. Append one line under the entry in its inbox file:
>    \`> Filed <today> → <destination>\`, where \`<today>\` is today's date as
>    \`YYYY-MM-DD\`, read from the system rather than guessed.
>
> Then move every inbox file whose entries are now all marked \`Filed\` into
> \`inbox/archive/\`, creating that folder if it is not there — with \`git mv\`
> when the brain is in a git repo, a plain move when it is not. Leave any file
> still holding an unfiled entry exactly where it is.
>
> If an entry you just filed replaces what a whole document said, move that
> document the same way into an \`archive/\` folder beside it —
> \`clients/archive/\`, \`decisions/archive/\`, always spelled lowercase — and
> add one line to the document that replaced it naming what it supersedes. Never
> delete a document, and never archive one this run's entries did not supersede.
>
> Create no new sections, rename nothing, reorganise nothing. Finish by replying
> with one line per entry filed — its date and where it went — and one line for
> each entry you left behind, saying why.
`
    }
  },
  {
    folder: 'strategy',
    title: 'Strategy',
    purpose: 'What this company is for, who it serves, and what it is betting on.',
    seed: {
      name: 'overview.md',
      summarySlot: '<!-- One paragraph a stranger would understand. -->',
      body: `# Strategy

## What we do
<!-- One paragraph a stranger would understand. -->

## Who it is for
<!-- The specific person or company. Not "everyone who needs X". -->

## Why us
<!-- What we can do that others cannot, or will not. -->

## What we are betting on
<!-- The assumption that, if wrong, changes everything. -->
`
    }
  },
  {
    folder: 'decisions',
    title: 'Decisions',
    purpose: 'Non-obvious calls, dated, with the reasoning. Superseded, never deleted.',
    seed: {
      name: 'log.md',
      body: `# Decision log

Newest first. Entries arrive here from \`inbox/\` when the weekly distillation
pass files them, or by hand. A decision that changes an earlier one supersedes
it with a new dated entry — the old one stays, so the reasoning is still
readable later.

Once this file runs past about twenty entries, or a decision needs more than a
screen, give that one its own file: \`decisions/YYYY-MM-DD-<slug>.md\`, opening
with a \`description:\` front matter line so the map can say what it is without
being opened, and leave a one-line pointer to it here. Both shapes sit side by
side; a file per decision is what this becomes at size.

## YYYY-MM-DD — <the call>

**Context.** What was true when this came up.

**Decision.** What we chose.

**Why.** What made it the right call, and what we gave up.
`
    }
  },
  {
    folder: 'rules',
    title: 'Rules',
    purpose: 'How work is done here. The agent follows these.',
    seed: {
      name: 'operating.md',
      body: `# Operating rules

How the agent should work on this company's files. Be specific — a rule that
could be read two ways will be.

- Capture as you go. Anything the next session would otherwise have to
  rediscover goes into \`inbox/<today>.md\` — use the \`record-decision\` skill.
  Filing it into the right section is the weekly distillation pass's job, not
  something to stop work over.
- Prefer many small linked documents over few large ones.
- Nothing is deleted. A document a newer one replaces moves into an \`archive/\`
  folder beside it — \`clients/archive/\`, \`decisions/archive/\` — and the
  document that replaced it says what it supersedes. Spell the folder lowercase
  \`archive\`. The agent's context map shows an archive as a count rather than a
  list, so history stays in the repo and out of every session's first read.
`
    }
  },
  {
    folder: 'clients',
    title: 'Clients',
    purpose: 'Who we work with, what was agreed, and where each engagement stands.',
    seed: {
      name: 'triage.md',
      body: `# Engagement triage

<!-- Flagged clients land below, dated. The client documents themselves are
     never rewritten by the automation. -->

## Automation prompt

Schedule as a **Weekly** automation against this repo (sidebar \`Automations\`
→ the \`+\`). Paste the prompt below and pick a day and time.

> Read every document in \`clients/\`. For each one, check git history for
> when it last changed and read what it says the next step is. Flag any
> client with no update in the last 14 days, and any whose next step is
> already due. Append the flagged list to this file, dated.
`
    }
  },
  {
    folder: 'product',
    title: 'Product',
    purpose: 'What we make: how it works, what is shipped, what is next.'
  },
  {
    folder: 'people',
    title: 'People',
    purpose: 'Who does what, and how the team runs.'
  },
  {
    folder: 'finance',
    title: 'Finance',
    purpose: 'Money in, money out, and what the numbers are supposed to be.',
    seed: {
      name: 'metrics.md',
      body: `# Metrics

<!-- Each automation run appends a dated entry below. -->

## Automation prompt

Schedule as **Weekly**, or pick **Custom cron** for a monthly close (sidebar
\`Automations\` → the \`+\`). Paste the prompt below.

> Read every document in \`finance/\`. Pull together the running numbers —
> revenue, spend, and burn — from what is recorded there and from git
> history for anything that changed since the last run. Append this
> period's numbers to this file with the date, and one line on the trend
> versus the period before. If a number is missing, say what is missing
> rather than guessing.
`
    }
  },
  {
    folder: 'content',
    title: 'Content',
    purpose: 'What we say publicly, and the voice it is said in.'
  },
  {
    folder: 'reviews',
    title: 'Reviews',
    purpose: 'Weekly and periodic looks back — what happened, what it means.',
    seed: {
      name: 'weekly-review.md',
      body: `# Weekly review

<!-- Newest entry first. The automation below writes here; nothing stops you
     from writing one by hand too. -->

## Automation prompt

Schedule as a **Weekly** automation against this repo (sidebar \`Automations\`
→ the \`+\`). Paste the prompt below and pick a day and time.

> Read every file changed in \`reviews/\` and every entry added to
> \`decisions/log.md\` in the last 7 days. Read \`strategy/overview.md\` for
> context. Write a new dated file in \`reviews/\` summarizing what shipped,
> what changed, and what needs a decision this week. End with the single
> thing that most needs attention. Keep it under a page.
`
    }
  }
]

function isEmptyDirectory(absolute: string): boolean {
  try {
    return readdirSync(absolute).length === 0
  } catch {
    return true
  }
}

export type ScaffoldResult = {
  created: string[]
}

export type ScaffoldOptions = {
  /** Section folders to create. Omitted means every one of them. */
  folders?: string[]
  /** The operator's one-line answer to "what does this company do?". */
  summary?: string
}

function seedBody(section: BrainSection, summary: string): string {
  const seed = section.seed
  if (!seed) {
    return ''
  }
  // Why: substituted rather than appended, so the document opens already
  // answered instead of carrying both the question and the answer.
  return summary && seed.summarySlot ? seed.body.replace(seed.summarySlot, summary) : seed.body
}

/**
 * Create the brain's sections in a repo that has none.
 *
 * Only ever adds. A section that exists is left exactly as it is, and a seed is
 * written only into a section that is empty — so re-running this can never touch
 * what the company has already written.
 */
export function scaffoldCompanyBrain(
  location: BrainLocation,
  options: ScaffoldOptions = {}
): ScaffoldResult {
  const brainRoot = location.root
  const chosen = options.folders ? new Set(options.folders) : null
  const summary = options.summary?.trim() ?? ''
  const created: string[] = []

  for (const section of BRAIN_SECTIONS) {
    if (chosen && !chosen.has(section.folder)) {
      continue
    }
    const absolute = path.join(brainRoot, section.folder)
    try {
      if (!existsSync(absolute)) {
        mkdirSync(absolute, { recursive: true })
        created.push(`${section.folder}/`)
      }
      if (!section.seed || !isEmptyDirectory(absolute)) {
        continue
      }
      const seedPath = path.join(absolute, section.seed.name)
      if (!existsSync(seedPath)) {
        writeFileSync(seedPath, seedBody(section, summary), 'utf8')
        created.push(`${section.folder}/${section.seed.name}`)
      }
    } catch {
      // A section we cannot create is not worth failing the rest for.
    }
  }

  // Regardless of which sections were chosen: capture is how anything reaches
  // any of them, and a brain set up without it depends on the operator saying
  // where to write every time.
  const skill = seedCaptureSkill(location)
  if (skill) {
    created.push(skill)
  }

  return { created: created.sort() }
}
