# Loops — design

**Date:** 2026-07-23
**Status:** approved, planning
**Surface:** `apps/client` (daemon + console), deletion in `apps/sync`

## Problem

Scheduling a verb to run on its own is spread across three half-built layers, none of which an
operator can see:

- **A cloud scheduler nothing calls.** `apps/sync/src/automations/` is a durable schedule store with
  leases, attempt counts, backlog caps, catch-up policy, and lease reaping — reconciled from each
  company's `automations.yaml` read out of its bare repo. The client half
  (`sync/automation-drain.ts`, `sync/automations-client.ts`) claims, heartbeats, and reports runs
  against it. The whole pipeline hangs off `ClientConfig.automationsSync`, and **no entrypoint sets
  it** — not `demo-setup.ts`, not `demo-orgs.ts`, not `daemon-entry.ts`. It has never run.
- **A local timer that works.** `wiring.ts:811-883` keeps `automations.yaml` in the workspace, stamps
  last-runs in a local JSON, and spawns a headless `claude -p /verb` session for each due def. This
  is the only part that has ever executed.
- **Two names and no surface.** The daemon calls them *routines* (`/api/routines`), the store calls
  them *automations*, and the right rail aliases `automations → brain` (`right-rail.js:19`), so the
  feature has no panel. The only UI is a mini list buried in the Skills section plus a "New
  automation" center tab (`skills.js:157-240`) that offers a verb and a cadence of
  hourly/daily/weekly — the operator cannot say "every weekday at 9am", which is the first thing
  they ask for.

Three layers, one name apiece, zero operator surface.

## The idea

One concept, one name, one surface: **Loops**.

A loop is a prompt (or a verb) plus a schedule. BuildEx's own daemon is the clock. Each fire spawns
an ordinary agent session — the same thing a chat does. The operator sees every loop in a dedicated
right-panel tab: what it does, when it next runs, how the last run went, one tap to run it now.

Everything that made this complicated was the cloud. It goes.

## Decisions (from brainstorming)

1. **Our daemon is the clock — not Claude Code's.** Claude Code's `/loop` is a session-level feature
   (a skill plus `ScheduleWakeup`/`CronCreate`) fired by its own supervisor daemon
   (`~/.claude/daemon/roster.json`, `~/.claude/jobs/`). There is no `claude cron` or
   `claude schedule` subcommand. Hooking into it would mean writing another product's private state,
   breaking on its upgrades, and running outside our gate and activity log. A loop *is* a timer plus
   a spawn; we already have both.
2. **Delete the cloud scheduler.** Loops run while the app is open. That is honest, it is what
   local-first means, and it removes ~1,100 lines that have never executed. "Runs while you sleep"
   is a real future feature; it will be designed against a real requirement, not kept as a seam.
3. **A loop runs a free-text prompt or a verb.** Operators think in "check the inbox and draft
   replies", not in skill names. Verbs stay available for the curated ones.
4. **Interval or time-of-day.** `every: 30m` or `at: "09:00"` with optional `days:`. Structured
   fields, not cron — renderable as a plain sentence, no parser, no humanizer.
5. **Definitions are committed; run state is not.** `loops.yaml` is git-tracked (invariant 2), so
   loops are reviewable in history and follow the operator to a new machine. Last-run stamps live in
   an uncommitted local file so scheduling churn never pollutes the brain.
6. **A gated run does not park — it re-runs.** See "The gate", below. This is a correction to the
   original brainstorming answer.

## Deletions

No behavior changes; all of this is unreachable today.

| Path | What |
| --- | --- |
| `apps/sync/src/automations/schedule-store.ts` + test | Durable runs, leases, backlog, reaping |
| `apps/sync/src/automations/tick.ts` + test | Cloud clock, bare-repo yaml reader |
| `apps/sync/src/automations/routes.ts` + test | `/automations/*` HTTP surface |
| mount in `apps/sync/src/http/app.ts` | Route registration |
| `apps/client/src/sync/automation-drain.ts` + test | Claim/heartbeat/report drain loop |
| `apps/client/src/sync/automations-client.ts` + test | Cloud schedule client |
| `ClientConfig.automationsSync`, `drainIntervalMs` (`wiring.ts:86-90`) | Dead config seam |
| `AutomationStore`, `migrateJsonToYaml` (`brain/automations.ts`) | Legacy JSON store + its migration |
| `skills.js:157-240` | The mini automations list and "New automation" tab editor |

`Automation`/`Cadence`/`CatchUp` types and `/api/routines` are replaced rather than deleted — see
below.

## The schedule format

`loops.yaml`, at the workspace root, read by the same tolerant flat `- key: value` parser we already
have (no `js-yaml` dependency). Unknown keys ignored; malformed items skipped.

```yaml
- name: monday-review
  title: Weekly review
  prompt: Read last week's activity log and draft the Monday update
  at: "09:00"
  days: mon
  enabled: true

- name: inbox-sweep
  title: Inbox sweep
  verb: triage-inbox
  every: 2h
  enabled: true
```

| Field | Rule |
| --- | --- |
| `name` | kebab-case, unique, stable identity. Derived from `title` when the operator doesn't supply one. |
| `title` | Human label for the card. Defaults to `name`. |
| `prompt` **or** `verb` | Exactly one. `verb` must name an installed skill; `prompt` is free text. An item with both, or neither, is skipped. |
| `every` | `30m`, `2h`, `1d`. Minimum 5m. |
| `at` | `"HH:MM"`, machine-local wall clock. |
| `days` | Comma list of `mon`…`sun`, only meaningful with `at`. Defaults to every day. |
| `enabled` | Defaults true. |

Exactly one of `every` / `at` per loop. No timezone field: local-first means the operator's machine
clock, and a loop that fires at 9am wherever they are is what they mean.

**Migration.** On first read, a legacy `automations.yaml` is converted into `loops.yaml`
(`cadence: hourly|daily|weekly` → `every: 1h|1d|7d`, `verb` preserved, `catchUp` dropped). The old
file is left on disk untouched (invariant 8).

## Firing

One 30-second timer in `wiring.ts`, replacing both branches at `wiring.ts:867-883`.

- **Never-run loops do not fire immediately.** A loop is stamped with a `firstSeen` on the tick that
  first observes it; its first fire is the next matching window. Creating a 9am loop at 2pm does not
  run it on the spot — `Run now` is the explicit path for that.
- **Coalesce, always.** Three missed windows produce one run, never three. `catchUp: each` is gone.
- **Late fires are bounded.** An `at:` loop fires late only within **4 hours** of its window;
  a laptop opened at 8pm does not run the 9am standup draft. The skipped window is recorded as
  `missed` and shown on the card. `every:` loops always coalesce-fire — an interval has no
  wall-clock meaning to be stale against.
- **At most 2 loop runs at once**, and never two runs of the same loop. Further due loops wait for
  the next tick. Three loops sharing a 9am window do not spawn three agents at once.

Each fire creates an ordinary session (`FileSessionStore.create({ title })`, titled after the loop)
and streams through the existing `runVerbInSession` path, generalized to take a prompt. A loop run is
indistinguishable from a chat run except for its origin — so the transcript, the gate, and the
activity log all work already.

**Run state** lives in an uncommitted `loop-state.json` beside the workspace:
`{ [name]: { firstSeen, lastRun, status, sessionId, blockedOn? } }`, with
`status: "ok" | "failed" | "needs-approval" | "missed" | "running"`.

## The gate

The original answer was "queue the approval and pause the run". **That cannot work**, and the reason
is load-bearing: `gate/approval.ts:14` auto-denies a pending card after 10 minutes, deliberately,
because the `PreToolUse` hook is blocked on that decision and must return before Claude Code's own
hook timeout (`GATE_HOOK_TIMEOUT_SECS = 660`). If it doesn't, Claude treats the timeout as a
non-blocking error and lets the tool proceed **ungated** — precisely what invariant 5 forbids. A run
cannot park overnight; there is a live agent process and a blocked hook holding the other end.

What happens instead:

1. A loop run hits a gated action with nobody watching. The card is created with
   `origin.kind === "automation"` (already supported, `approval.ts:20-33`) and auto-denies at TTL.
2. The broker's resolve event writes `status: "needs-approval"` and `blockedOn: <the action>` into
   that loop's run state.
3. The card reads **"Weekly review needed you — it tried to email the team"**, with a **Run now**
   button.
4. The operator taps it. They are present, so the gate card appears live and they approve it inline,
   exactly as in a chat.

No gate changes at all. Standing per-loop pre-authorization — a loop that may send email without
asking, every time — is a real feature and explicitly **out of scope** here; it needs its own
design against the policy matrix.

## The daemon API

`/api/routines` → `/api/loops`. Same shape as the existing block at `daemon.ts:608-634`.

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/api/loops` | `{ loops: [{ name, title, prompt?, verb?, schedule, enabled, nextRun, lastRun, status, sessionId?, blockedOn? }] }` |
| `POST` | `/api/loops` | `{ title, prompt? \| verb?, every? \| at?, days?, enabled? }` → the created loop |
| `PATCH` | `/api/loops/:name` | Partial update |
| `POST` | `/api/loops/:name/run` | Fire now → `{ sessionId }` |
| `POST` | `/api/loops/:name/toggle` | Enable/disable |
| `POST` | `/api/loops/:name/remove` | Delete |

`schedule` is returned both structured and as a rendered sentence (`"every Monday at 9:00 AM"`), so
the console never re-implements the phrasing and the string is testable server-side.

The `deps.catalog.routines()` fallback (`daemon.ts:632`, `wiring.ts:306`) is dropped — the loops
engine is always present.

## The tab

A third button in `#rtabs` (`index.html:56`), after Brain and Documents, with a repeat/clock glyph.
`web/js/loops.js` registers `loops` in `RIGHT_PANELS` (`right-rail.js:18`); `automations` and
`routines` become aliases pointing at it instead of at the brain.

**A loop card** carries, top to bottom: the title; the prompt or verb, one line, clamped; the
schedule sentence; the next run as relative time ("in 3 days"); a status chip for the last run —
green *Ran*, amber *Needed you*, red *Failed*, grey *Missed* — that links to the session transcript.
A toggle switches it off without deleting it. A `⋯` menu holds Run now, Edit, Delete.

**The composer** — "+ New loop" — is a prompt textarea plus a schedule picker with two modes (every
N minutes/hours, or at HH:MM on chosen days), a live sentence preview underneath, and a Create
button. A verb picker sits behind "or run one of your verbs".

**Empty state** offers two or three seeded suggestions ("Draft the Monday update", "Sweep the
inbox") that pre-fill the composer rather than creating anything.

**The tab badges** when any loop is in `needs-approval`, so a blocked loop is visible without opening
the panel.

## Tests

All hermetic — injected clock, injected spawn, no network, per the repo's test-first rule.

| Suite | Covers |
| --- | --- |
| `brain/loops.test.ts` | Parse/serialize round-trip; `prompt` xor `verb`; bad `at`/`every`/`days` skipped; legacy `automations.yaml` migration leaves the old file intact |
| `brain/loops-due.test.ts` | Due computation as a table: intervals, time-of-day, day-of-week, `firstSeen` suppression, coalesced missed windows, the 4-hour late bound, a DST spring-forward and fall-back day |
| `brain/loops-schedule-sentence.test.ts` | The rendered sentence for each schedule shape |
| `daemon/loops-routes.test.ts` | Each route, plus name collision, unknown loop, and invalid schedule rejection |
| `wiring` scheduler test | Fake clock + fake spawn: fires once per window, honors the 2-run cap and the per-loop lock, records `ok`/`failed`/`missed`, writes `needs-approval` on an automation-origin auto-deny |
| `console-render-loops.test.ts` | jsdom render, following the existing `console-render-*.test.ts` pattern: card contents, empty state, toggle/run wiring, the badge |

## Out of scope

- Loops that run while the app is closed (the deleted cloud scheduler's ambition).
- Standing per-loop pre-authorization of gated actions.
- Cron expressions; per-loop timezones; chained or conditional loops.
