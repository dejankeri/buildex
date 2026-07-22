# Brain stewardship — the agent tends the brain — design

**Date:** 2026-07-22
**Status:** rule shipped; the gated "merge request" path is a captured seam
**Surface:** `packs/core/rules/operating.md` (the core layer of every workspace `CLAUDE.md`)

## Problem

The brain was a passive store: the operator (or a verb) puts things in; nothing keeps it sharp. Left
alone, a brain only grows and rots — stale docs, decisions re-made by hand, repeatable work never
turned into a verb, gates that don't match real risk. The agent uses the brain but was never told to
*curate* it.

## What shipped

A new **"Tend the brain"** section in `packs/core/rules/operating.md` — so every company's agent, on
every session, is instructed to notice when the brain itself should change and to **offer the change
inline**. Signals it watches (a task done twice → a verb; a repeated judgment → policy/convention; an
outward action that keeps hitting the gate, or a risky one that doesn't → a gate change; a stale doc
or unused verb → prune; something important said but unwritten → capture). Rules for offering: one
line where the work is happening, only on a real/repeated/consequential signal, never nag.

**The bright line:** editing files is autonomous (invariant #5), but a *structural* change to how the
company runs — a new policy, a new gate, removing a verb — is the operator's call. The agent proposes
it and acts on their yes, never before. It never silently rewrites the company's ruleset.

**The enable mechanism (today):** an offer in the live AI chat is enough — the present operator taps
yes and the agent makes the change. No separate approval surface is needed while a human is in the loop.

## Captured seam — "merge request against the brain"

An in-chat yes works *because a human with authority is present*. Two future cases break that
assumption and should route a proposed brain change through a **gated approval** instead — a merge
request against the brain, reviewed before it lands:

1. **Non-interactive proposals.** Once loops/automations exist, a scheduled run may detect a
   stewardship signal with no operator present. It must not self-approve a structural change; the
   suggestion waits as a gated item for a human to accept. (Invariant #5: money / outbound /
   irreversible — and "changes the rules" — wait for a human tap.)
2. **Lower-privilege proposals.** A teammate without authority to change the company's ruleset can
   *propose* a verb / policy / gate change, but it lands only after someone with rights approves it —
   enforced by the server-side permission matrix (invariant #6), surfaced on the company activity log.

Both are the same shape: a proposed brain mutation + a reviewer + an accept/decline, versioned in git
so every change to how the company runs is visible and reversible (invariant #9). The seam exists now
(the rule distinguishes "propose" from "do", and the Gate already models human approval); the engine —
a review queue for brain changes with per-tier routing — is built when loops and the permission tiers
land (invariant #10: build the seam, not the engine).

## Out of scope (for now)

- The review-queue UI and the per-tier routing (the "engine" above).
- Any change to the live gate/approval system — this is a rule + a recorded direction, not new code.
