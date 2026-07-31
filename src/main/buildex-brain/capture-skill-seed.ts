import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrainLocation } from '../../shared/buildex-brain-types'
import { skillsRoot } from './skill-link'

// The one skill every company brain starts with: how to write something down.
//
// The agent could already write here — the gate allows Write/Edit over tracked
// markdown in the brain, and `brain-write-target.ts` bounds where. What was
// missing was the convention. Two agents on two different nights, told "record
// this", produced two shapes; an operator reading the week could not read it as
// one log. This is that convention, in the one place the agent already looks.
//
// Kept short on purpose. A skill an agent has to wade through gets skimmed, and
// one an operator finds too long to audit never gets read at all.

export const CAPTURE_SKILL_NAME = 'record-decision'

const FENCE = '```'

const CAPTURE_SKILL_BODY = `---
name: ${CAPTURE_SKILL_NAME}
description: Use when a decision is made, a number is agreed, or something is learned that the next session would otherwise have to rediscover — including when asked to "record this decision" or "record this learning".
---

# Record a decision

Write it down where the next session will find it. One entry, one place, dated.

## Where it goes

| What happened | File |
| --- | --- |
| A call that could have gone another way | \`decisions/log.md\` |
| Something about how this company works | \`rules/operating.md\` |
| Anything else | the document for that area — \`clients/\`, \`finance/\`, \`product/\`, … |

Those paths are relative to the company brain. \`.claude/company-context.md\`
says where that folder is and what is already in it; read it if you are unsure.
Never write outside it, and never create a second log next to an existing one.

## How to write it

Append the entry directly under the file's \`#\` heading, above the entries
already there, so the newest is first:

${FENCE}
## 2026-07-31 — Priced the starter tier at $49

**Context.** What was true when this came up.

**Decision.** What we chose.

**Why.** What made it the right call, and what we gave up.
${FENCE}

- Get today's date from the system (\`date +%F\`) rather than guessing it, and
  write it \`YYYY-MM-DD\`.
- One entry per decision. Two decisions are two entries.
- Never edit or delete an earlier entry. A decision that replaces one gets its
  own entry saying which it supersedes.
- Write what a reader six months from now needs. No preamble.

## Check before finishing

- The entry went into a document that already covers this, not a new file beside it.
- The date is today's, in \`YYYY-MM-DD\` form.
- Nothing that was already in the file changed.
`

/**
 * Write the capture skill into a brain that has none.
 *
 * Only ever adds: a brain whose operator has edited or replaced this skill keeps
 * theirs. Returns the brain-relative path written, or null when there was
 * nothing to do. The link into `.claude/skills/` is not built here — the scan
 * that follows setup relinks the whole folder, and that is the one place that
 * knows the repo.
 */
export function seedCaptureSkill(location: BrainLocation): string | null {
  const directory = path.join(skillsRoot(location), CAPTURE_SKILL_NAME)
  const manifestPath = path.join(directory, 'SKILL.md')
  if (existsSync(directory)) {
    return null
  }
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(manifestPath, CAPTURE_SKILL_BODY, 'utf8')
  } catch {
    return null
  }
  return `skills/${CAPTURE_SKILL_NAME}/SKILL.md`
}
