import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrainLocation } from '../../shared/buildex-brain-types'

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

Newest first. A decision that changes an earlier one supersedes it with a new
dated entry — the old one stays, so the reasoning is still readable later.

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

- Capture non-obvious decisions in \`decisions/log.md\` in the same session.
- Prefer many small linked documents over few large ones.
- Nothing is deleted; supersede and keep the history.
`
    }
  },
  {
    folder: 'clients',
    title: 'Clients',
    purpose: 'Who we work with, what was agreed, and where each engagement stands.'
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
    purpose: 'Money in, money out, and what the numbers are supposed to be.'
  },
  {
    folder: 'content',
    title: 'Content',
    purpose: 'What we say publicly, and the voice it is said in.'
  },
  {
    folder: 'reviews',
    title: 'Reviews',
    purpose: 'Weekly and periodic looks back — what happened, what it means.'
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

  return { created: created.sort() }
}
