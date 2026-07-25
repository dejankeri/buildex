# Launch walkthrough - verify the whole product, and leave a replayable runbook behind

**Date:** 2026-07-25

All the components for a first launch exist. Nobody has walked the product end to end as one
operator, in order, on a machine with no prior state. This design covers that walk - and makes its
by-product a runbook an agent can replay whenever we want the same check again.

Two deliverables, one activity: a product that has been *seen* to work, and a document that lets
someone re-see it without us.

## Why a walk, and not more tests

The repo has 154 hermetic suites and they are not the gap. They prove each seam behaves; they
cannot notice that the quick tour points at a rail that no longer exists, or that a cutover
checklist was half-completed. Those are integration-of-reality bugs: true only when the pieces,
the docs, and the live services are all in the room together. Finding them needs a walk.

Both examples above are real - both were found while scoping this design, before the app was
opened once.

## Shape: three passes

1. **The spine.** One operator, first launch, straight line. Thin on purpose - prove each step
   works at all and that the handoffs between them hold. A break here is a launch blocker by
   definition, so this pass runs first and nothing else starts until it is clean.
2. **Depth.** Back over each surface for edge cases, empty and error states, and everything the
   happy path never reaches.
3. **Packaged acceptance** (optional, deferred). Re-run the recorded journey against a real signed
   install to catch packaging-only failures. Not scheduled; noted so it is not forgotten.

The cloud is in scope for pass 1, not deferred. Backup on day one is part of what a first launch
promises, so an unexercised cloud path is an unverified launch.

### The environment

Canonical for every pass: this worktree's demo dir wiped, then `npm run demo:app:here` with the
cloud env sourced. Chosen over a packaged install because a test agent must be able to **reset**,
and reset is what makes the runbook replayable rather than a one-time record. The packaged install
trades that away for realism; pass 3 buys it back once, later.

## Pass 1 - the journey

Derived from the console's actual composition (`apps/client/web/index.html` and the modules it
loads), not from `DEMO.md` - which describes a right rail the product has since replaced.

| # | Step | What has to hold |
|---|---|---|
| 1 | Boot from zero | daemon up, window opens, no console errors, CSP clean |
| 2 | "Name your company" dialog | cloud branch, local-only branch, empty-name branch; never mints a second anonymous company |
| 3 | First-run wizard | full step sequence including "Connect your agent" |
| 4 | Quick tour | coach-marks anchor to regions that still exist |
| 5 | Org bar | sandbox badged local-only; sign-in correctly gated off there |
| 6 | First session + first chat turn | model/effort pickers, attach, streaming, working trace, title from first message |
| 7 | Documents | new doc, split editor, choose brain location, reader + history + Edit |
| 8 | Files tree | find-files, click-to-open |
| 9 | Brain rail | renders from repo state, zero LLM (invariant 9) |
| 10 | Skills | read, Teach (validated, linked, committed), Run |
| 11 | Store | install an app; connect a connector; Sync now files into `sources/<name>/` with provenance; credentials to the keychain, never the repo |
| 12 | The gate | a gated action reaches Pending; approve path and deny path; a ledger line for each (invariant 5) |
| 13 | Mini-apps | own folder, egress by declaration, secrets in daemon custody |
| 14 | Loops | create, machine opt-in, run history, notification when one needs you |
| 15 | Checkpoint vs save | checkpoints as safety net; a named save is one meaningful commit (invariant 2) |
| 16 | Sync | sync dot, recent-changes log, real push, conflict surfacing |
| 17 | Account | sign in, your company, disconnect, log out |
| 18 | Close and reopen | sessions and transcripts still there |
| 19 | Usage strip | live usage renders |

Steps 2, 12, 15 and 16 carry the most risk: newest code, most state.

## The runbook

`docs/testing/first-launch-runbook.md`, written **as each step is verified** - never ahead of it, so
the document only ever describes behaviour that was observed. A runbook written from intent
describes the product we meant to build; this one describes the product that exists.

Per step: an id, a precondition, the action (selector or visible text), the expected observable
state, and any known flakiness. Plus a **Reset** section, and an **Environment** section naming the
required variables without carrying their values. Pass 2 adds `docs/testing/edge-cases.md`.

Driver-agnostic prose rather than executable specs. The judgements that matter most here - does
this read right, does this feel broken, is this promise true - are not assertable, and a browser
agent can act on prose. Promoting the deterministic spine into executable tests stays open as a
follow-up once the steps stop moving.

## Rhythm

At each step: drive it, observe, then classify every finding as **fix now** (small, in flow),
**queue** (needs its own change), or **accept** (with the reason recorded). Fixes follow the repo's
existing contract - test-first at the seam, then `task ci`, suites run one at a time. Commits are
per coherent step-group, reasoning argued in the message.

## Findings before step 1

Scoping surfaced four, recorded here because they are already true:

1. **Stale tour copy.** `web/js/tour.js` tells the operator the right panel switches between
   Pending, Files and Skills. It switches between Brain, Documents and Loops.
2. **Stale `DEMO.md`.** Describes the same retired rail.
3. **Half-finished cutover.** The sync service has all three identity secrets deployed and
   `POST /session` answers live. The Supabase project had neither the loopback redirect
   allow-listed nor a provider enabled - so the desktop sign-in path could not have completed.
   The redirect allow-list and site URL were fixed while scoping; enabling the provider needs an
   OAuth client and remains open.
4. **`infra/infrastructure.md` overstates the cutover**, presenting the checklist as done. Correcting
   it is part of this work.

Finding 3 is the load-bearing one: anonymous onboarding was verified working against the live
project, so first launch has a real path to backup, but the sign-in surfaces an existing operator
would use were not reachable.
