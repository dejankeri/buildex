# Manual save - design

**Date:** 2026-07-21
**Status:** approved design, not yet planned or implemented
**Supersedes:** the sync-triggering behaviour described in
`docs/superpowers/specs/2026-07-21-sync-account-design.md` (Phase 2). See "What this supersedes".

Work stays on the operator's machine until they choose to save it. One pinned item in the pending
tray says how much is waiting; one click sends all of it.

## The rule

**Other people's work arrives on its own. Yours leaves only when you say so.**

That sentence is the whole model, and it is short enough to say to a non-technical operator without
qualification.

## Why change

Today `SyncScheduler` debounces edits for two seconds and then commits *and pushes*, and
`wiring.ts`'s `touchAfterRun` fires the same path after every agent turn. So every burst of work
reaches the cloud whether or not the operator considers it finished. An operator who is mid-thought,
or who has just watched the agent do something they dislike, has already published it.

## Decisions

### 1. Work is recorded locally as it happens; only sending is manual

The request was for edits to behave like uncommitted changes. This design separates the two things
that request bundles together:

| | Before | After |
|---|---|---|
| Recording work locally | automatic | automatic (unchanged) |
| Sending it to the cloud | automatic | **one click** |

From the operator's side the behaviour is exactly as requested: they work, one item reports unsaved
changes, one click sends everything. Underneath, their work is still checkpointed on their own
machine as they go, because three things already depend on that and would break silently without it:

- The document editor promises, verbatim: *"Your current version is kept in history, so this can be
  undone."* With no local checkpoints there is nothing to restore to.
- The change log (`GET /api/changes`) and `brain/history.ts` read `git log`. Uncommitted work leaves
  both empty until the operator clicks.
- The agent edits files autonomously. Invariant 8 says never lose an operator's work; loose edits
  with no checkpoints give a bad agent run no way back.

Nothing leaves the machine until the operator acts. The local checkpoints are invisible to them.

### 2. Incoming is automatic, outgoing is manual

Receiving costs the operator nothing and a teammate's work appearing is expected. Making both
directions manual lets an operator drift days behind their team, so the eventual save has far more to
reconcile. Asymmetry here is the simpler behaviour to explain, not the more complex one.

### 3. Saving is fully manual, with an escalating nudge - and that has a real cost

No automatic save on quit, on a timer, or on any other trigger. The operator is never surprised by
work leaving their machine.

**Accepted risk, stated plainly:** a lost or dead laptop loses everything since the last save. The
nudge is the only mitigation and a nudge is not a guarantee. This is a deliberate trade of durability
for control. If operators are observed losing work, the decision to revisit is "save automatically on
quit", which was considered and rejected here.

### 4. The vocabulary is "save", not "share" or "publish"

The action covers both the team space and the operator's private space. "Share" is wrong for the
private space, which is theirs alone. "Save" is the word a non-technical person already has for this,
and the risk it names - unsaved work - is the one they actually feel.

It is a small simplification: the work *is* already safe on their machine. The card's supporting line
carries the precision ("haven't been saved to your company yet") so the headline can stay short.

`push`, `commit`, `branch`, `merge` and `diff` appear nowhere in this feature's operator copy, which
matches the existing UI: those words are absent from the console today except three deep-linked
places.

## Architecture

### Engine: one operation becomes three

`SyncEngine.syncWritable()` currently performs stage → commit → fetch → rebase → push as one
indivisible act. That fusion is precisely why every edit reaches the cloud. Splitting it is the
change:

| Operation | Does | Network | Called when |
|---|---|---|---|
| `checkpoint(dir)` | stage, then commit | none | debounced edits; after every agent run |
| `receive(dir)` | fetch, rebase onto `origin/main` | inbound | background tick |
| `publish(dir)` | `checkpoint`, `receive`, then push | outbound | **only when the operator clicks** |

`syncReadonly(dir)` is unchanged and still handles `core`.

The staging exclusions (`.conflicts`, `.sync-needs-help`, `.sessions`, `.agent`) move to
`checkpoint`. The conflict path - `backupAndReset()` copying divergence to `.conflicts/<ts>/` and
writing `.sync-needs-help` - moves to `receive`, which is the only place remote history now arrives.

`hasRemote()` still guards `publish`: with no account, publish is a no-op returning `"local"`.

### Scheduler: same shape, different calls

`SyncScheduler` keeps its debounce (2s quiet, 10s max wait), its offline backoff, and its 45s tick.
Only the targets change:

- debounce → `checkpoint` (local, no network)
- 45s tick → `receive` on writable roots, `syncReadonly` on `core`
- nothing schedules `publish`

`wiring.ts`'s `touchAfterRun` checkpoints instead of syncing.

Two incidental improvements fall out. The debounce gets faster and cannot fail from a network error,
because it no longer touches the network. And `syncReadonly` finally gets called - it is implemented
today but unreachable, because `SyncEngineLike` declares only `syncWritable`.

`publishAll()` is added as the operator-triggered entry point: call `publish` on every writable root
and collapse the results into one status. It does not checkpoint separately - `publish` already
checkpoints, and doing it twice would be two ways to describe one step.

### Counting unsaved work

`git diff --name-only origin/main..HEAD`, counted. **Files, not commits** - an operator thinks in
documents, not revisions. Ten edits to one document is one unsaved thing to them.

Age comes from the oldest unsaved checkpoint (`git log --format=%ct origin/main..HEAD | tail -1`),
so the nudge needs no new stored state and is testable on the existing injected `Clock`.

When no upstream exists yet (a connected account that has never published, or no account at all), the
range degrades to counting everything on `HEAD`.

## What the operator sees

### The pending tray

The right panel's default tab is already the pending tray - *"Pending - outward actions wait for
you"* - and sending company data to the cloud is an outward action, so this belongs there under
invariant 5. It renders as one card pinned above the approval cards:

```
●  Save your work
   14 changes on this machine haven't been
   saved to your company yet.
                            [ Save now ]
```

It is not an approve/deny pair and has no TTL auto-deny; it is a single action with no decline, so it
is visually related to the approval cards but distinctly shaped. It appears only when there is
unsaved work.

**After 24 hours** the same card escalates - stronger colour, plainer stakes:

```
●  Save your work
   This work has been on this machine for 2 days.
   It exists nowhere else.
                            [ Save now ]
```

**With no account**, the button reads `Connect an account` and the supporting line explains the work
is staying on this machine. It still appears only when there is unsaved work, so it is never a
permanent advertisement in a tray that otherwise means "something needs your decision".

**Never in the Acme sandbox org**, which is deliberately local-forever and already badged "Sandbox ·
local only · never synced".

### The status dot

Gains one state, `unsaved`: neutral, not alarming, tooltip *"You have unsaved work · click to save"*.

Clicking the dot currently always opens the change log (`boot.js`). It now routes by state: when
there is unsaved work it opens the pending tray, where the action is; otherwise it opens the change
log as it does today. The dot should lead to whatever the operator most likely wants, and an
unchanged destination would send someone who just noticed unsaved work to a list of things that
already saved.

The existing states already cover the rest: `busy` while saving, `queued` when a save failed and will
retry, `help` when a conflict needs attention, `local` for the sandbox.

## API

Both endpoints exist; neither is added.

| Endpoint | Before | After |
|---|---|---|
| `GET /api/sync` | a bare status string | `{ status, unsaved: { files, oldestAt } }` |
| `POST /api/sync` | force a flush | **save now** - publish every writable root |

## What this supersedes

`docs/superpowers/specs/2026-07-21-sync-account-design.md` (Phase 2) states that `attach.ts` adds a
remote, fetches, and then delegates to `syncWritable()`. That operation no longer exists in that form.

Under this design, attach delegates to `receive` and then performs one explicit **first publish**.
That is the correct behaviour regardless: connecting an account is the one moment the operator has
unambiguously consented to sending everything they have.

The rest of the Phase 2 design is unaffected - provisioning, the keychain, the `GIT_CONFIG_*`
credential path, per-org accounts, and the attach-in-place migration all stand.

## Error handling

| Case | Behaviour |
|---|---|
| Save fails (offline) | Status `queued`; the card stays with its count; existing backoff retries the publish |
| Save fails (conflict on `receive`) | `backupAndReset()` to `.conflicts/<ts>/`, `.sync-needs-help`, status `help` |
| Save clicked with no account | Button is `Connect an account`; publish is never attempted |
| Save clicked with nothing unsaved | Card is absent, so unreachable from the UI; `publishAll()` is a no-op returning `no-change` |
| Checkpoint fails | Surfaced as `help`; work remains on disk untouched (invariant 8) |
| Agent run mid-save | Existing flush serialization applies: a second request sets `rerun` rather than overlapping |
| No upstream yet | Counts everything on `HEAD`; the first publish sets it |

## Testing

The scheduler's injected `Clock` already makes this hermetic - no real timers, no network in unit
lanes.

- `checkpoint` commits and **makes no network call** - the load-bearing assertion of this design.
  Asserted by driving a root with no remote configured and confirming success.
- The debounce path never pushes: after any number of `touch()` calls and any amount of fake-clock
  time, a bare remote receives nothing.
- The 45s tick receives but does not push.
- `publishAll()` pushes exactly once per writable root.
- Unsaved counting: zero when level with the remote, correct file count across multiple commits
  touching the same file twice, and the no-upstream degradation.
- Nudge escalation crosses the 24-hour threshold on the fake clock, in both directions.
- Conflict during `receive` produces `.conflicts/<ts>/` with byte-identical copies - this is where
  `lib/git-pin.ts`'s line-ending pin is load-bearing on Windows.

The existing `[release-gate:sync-safety]` suite must be extended rather than replaced: its guarantee
that work is never lost still holds, and now covers a longer window between saves.

## Out of scope

- Automatic saving on quit or on any timer (decision 3).
- Selecting *which* changes to save. It is all or nothing, per root set.
- Undoing a save after it has been sent.
- Any change to `core`, which stays read-only and pull-only.
- Any change to the automations drain, which remains unwired.
