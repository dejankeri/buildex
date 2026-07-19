---
name: tidy
description: Use when the workspace has drifted - loose files, stale drafts, inconsistent naming - and you want it organized back to the conventions without losing anything.
---

# tidy - housekeep the workspace to its conventions

Reorganizes files to match `conventions.md`, as support for the team, never destructively and
always on their terms.

## When to use

- A backfill or a busy stretch left files loose or inconsistently named.
- New material landed in `sources/` and needs filing into the brain.

## Steps

1. Read `conventions.md` and survey the workspace and `sources/`.
2. Draft the moves, renames, and merges as a **reviewable diff** - do not apply silently.
3. Where a doc supersedes another, archive the old one rather than deleting it.
4. Summarize what changed and why, so the team can approve at a glance.

## Rules

- Never delete; supersede and archive. Every change is a reviewable commit.
- Organize as support, not as a pipeline - the team's conventions win over yours.
- Leave `sources/` provenance frontmatter intact.
