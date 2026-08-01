# BuildEx on Orca — progress

Fork: `~/code/buildex-app`, branch `buildex/phase-0-identity`, **local only — nothing pushed**.
Tracking `upstream/main` = `github.com/stablyai/orca`.

Last walked against the code on **2026-08-01**, at the end of the first-principles
audit (16 work packages). Every claim below was checked against a file at HEAD;
where a claim and the code disagreed, the code won and the claim was rewritten.

## Status

| Phase | Status |
|---|---|
| 0 — toolchain, isolated clone, identity before first launch | ✅ |
| 0.5 — seam spike + rebase drill (**GO/NO-GO**) | ✅ **GO** |
| 1 — release feed, bundle IDs, branding, icons, star-nag off | ✅ |
| 2 — Brain: full-screen surface over `.buildex/`, edited in place | ✅ |
| 3 — Store: a client of the plugin marketplaces the agent already has | ✅ |
| 4 — auto-feed company context to the agent | ✅ |
| 5 — sync | ✅ *by decision — see below* |
| 6 — shipped catalog: Store works on first run | ✅ |
| 7 — gate: allow/ask/deny, enforced by the agent runtime | ✅ *engine + settings; approval cards won't-build — see below* |
| — Portfolio: one read-only screen over N businesses (added by the audit, not a planned phase) | ✅ |

## Phase 5: why there is no sync code

Orca already ships commit, push, pull, branch management, and PR review, and the
Brain panel surfaces uncommitted documents. The company repo is a git repo, so
sync is `git push`. Building a second sync path would duplicate a surface the
operator already has and add a state machine that can disagree with git.

If a cloud sync is ever wanted, it belongs behind the existing remote, not beside it.

## What works

- **Company Brain** (left rail, full screen) — ten sections over `.buildex/`
  (`BRAIN_SECTIONS` in `brain-scaffold.ts`: inbox, strategy, decisions, rules,
  clients, product, people, finance, content, reviews), a `sections filled`
  counter, the skills the company wrote, and history of every save with the diff
  each one made. Documents are written **in the Brain** with the app's own rich
  markdown editor; YAML front matter is held back from the editor and put back
  byte for byte, so a skill's `name:` and `description:` survive editing.
  Deterministic: same repo in, byte-identical output.
- **Setting one up is a choice** — a repo with no brain is offered setup rather
  than given one. Nothing is written until the operator picks their sections and
  presses the button; the one line they type about the company becomes the first
  line of `strategy/overview.md` rather than a form field that goes nowhere.
  `inbox` is created whether or not it was picked — it is the only destination
  the capture skill knows, and a capture with nowhere to land is a lost capture.
- **A document knows what points at it** — front matter `description:` is read as
  data (160 characters, halved to 80 in the agent's map), a `Linked from` list
  shows backlinks, a recency list is read from `git log`, and a link to a page
  that does not exist yet is collected as a **wanted page** rather than dropped.
  Nothing is deleted: the seeds teach an `archive/` folder beside each section for
  superseded documents, and the context map renders any such folder as a count
  rather than a list (`ARCHIVE_SEGMENT_RE` in `company-context.ts`).
- **What the agent sees** — a read-only view of the context chain, from the ⋯ menu.
  Splits what is loaded in full at the start of every session (project memory)
  from what is only named and opened on demand (skills, connected apps,
  documents). Operators conflate the two constantly. Rendered from disk with no
  model, and it **does not simulate the agent's own import resolution**: a memory
  file is shown verbatim, an `@` line is listed exactly as written, and selecting
  one **reveals it in the file manager** rather than opening or inlining it. A
  connected app is its name plus its host or its program's basename — headers,
  `env` and arguments are never read, so there is no value left to mask.
- **Removing a brain cannot lose one** — the removal is committed when git holds
  the brain, and a copy goes to `~/.buildex-backups/<repo>-<stamp>/` when anything
  is uncommitted or there is no git; when both apply, both happen, and the backup
  runs first so a failed backup aborts the removal. Nothing outside `.buildex/`
  is staged or touched, and `.claude/skills/` links left pointing at nothing are
  pruned.
- **Store** — a client of the plugin marketplaces the coding agent already has.
  It does **not** unpack anything: installing shells out to the agent's own CLI
  (`claude plugin install <plugin>@<marketplace> --scope user`), and
  `~/.claude/plugins/installed_plugins.json` is the only truth about what is
  installed. **No plugin bytes and no skill scaffold reach the company repo** —
  so there is nothing of the app's to overwrite and nothing to keep on uninstall.
  What BuildEx does write there is what a marketplace does not carry: installing
  or uninstalling re-syncs the gate and the agent's context file
  (`syncRepoAfterChange` in `ipc/buildex-store.ts`), for every company opened this
  run. `--scope user` is deliberate: isolation between businesses comes from
  credentials and the gate, not from installing the same plugin N times.
- **Store, on first run** — three marketplaces ship with the app
  (`anthropics/claude-plugins-official`, `dejankeri/buildex-packs`,
  `dejankeri/protocol-claude-plugin`), so a repo with no marketplace of its own
  still has a full shelf. The **indexes are fetched and cached, not bundled** —
  a bundled copy would be guaranteed-stale JSON in the app. What does ship is 19
  small overlay files under `resources/buildex/overlays/`, of which 7 are
  curations (Asana, Calendly, HeyGen, HubSpot, Linear, Protocol CRM, Stripe); the
  other 12 only place a software plugin on the shelf and vouch for nothing. Six of
  the seven show a **Curated** badge; Protocol CRM is the one overlay carrying a
  `gate`, so it shows **Ask-first** instead — the stronger statement, since it
  says the agent will stop and ask. A company can add its own marketplaces, and
  its brain's additions are part of the shelf that company sees.
- **Credentials are per business** — a plugin's API key is stored under
  `pack-credentials/<companyKey>/<plugin>.enc`, where `companyKey` is derived
  from the **primary checkout**, so N worktrees of one business are one identity
  rather than N. A pre-company global key is still read as a fallback and is
  never written, moved or deleted; disconnecting writes a `<plugin>.disconnected`
  tombstone that shadows it, because deleting the shared file would disconnect
  businesses the operator said nothing about. A PTY that is not in a workspace —
  a bare `$HOME` shell — receives no company environment at all.
- **Agent context** — writes `.claude/company-context.md` and an `@`-import into
  `.claude/CLAUDE.md`, so the next agent session starts knowing the company.
  Refreshed automatically whenever the map can have changed: the Brain opening, a
  document created, an app installed or removed, an automation dispatching. There
  is no button — a context someone has to remember to refresh is a context that is
  usually wrong. Both files sit in `.claude/`, git-excluded: this is derived
  machine state, so committing it would churn the company's history for nothing.
- **The gate** — the allow/ask/deny preset is written into the company repo's
  `.claude/settings.json`, so the agent's own runtime enforces it. Wide
  autonomy: reading, editing, searching, shell and web run without interruption;
  `rm -rf`, force-push and `reset --hard` wait for a person. A company can
  override the preset in `.buildex/gate-preset.json`; a preset that is not an
  object at all falls back to the shipped one rather than to no gates, and a
  partial one falls back list by list. The receipt of what BuildEx wrote lives in
  `.claude/gate-applied.json` beside the settings it describes — in `.buildex/`
  it was committed into the company's history, and its presence alone made every
  repo look like it already had a brain.
- **Automations are the operating rhythm** — Orca's own scheduler, pointed at
  documents the company already has. Both dispatch paths load the company before
  the startup agent's first message: a **New run** worktree as it is created, an
  existing **Worktree** at dispatch. The brain seeds four ready-to-paste prompts
  (`inbox/distillation.md`, `reviews/weekly-review.md`, `clients/triage.md`,
  `finance/metrics.md`); nothing runs until the operator schedules it.
- **Portfolio** — one read-only screen over every business: brain state, unsaved
  count, last automation run, installed apps, and where the brain lives. It writes
  to nothing it summarises (`readOnly` on the scan and catalog requests), probes
  before it scans so a repo that is not a business is never read, and bounds both
  the probe and the read so a blackholed SSH host costs its own row and never the
  screen.
- **Everything Orca does** — untouched. Worktrees, terminals, diffs, agents, SSH.

## Decisions of record

Settled during the 2026-07/08 first-principles audit. They are recorded here so a
future session does not re-derive them. Reopen one only with a reason that is new.

**In scope, and staying.** Multi-operator and teammates: the external-brain
subsystem and roster governance are kept, by owner decision. A brain in its own
repo is the shape that survives more than one person.

**The do-not-build list.** Not gaps — decisions:

- **A sync service.** Git is sync. See Phase 5 above.
- **A BuildEx scheduler.** Orca's automations engine is the scheduler; this fork
  points it at company documents and adds nothing to it.
- **Inline approval cards.** The terminal's own ask prompt *is* the approval card,
  and the alternative needs a PreToolUse hook in global state shared with the
  operator's real Orca. Won't-build for v1 — see the gate section below.
- **A gate audit ledger.** Deferred, not dead: build it when unattended parallel
  runs exist and there is something to audit that a person did not watch.
- **Per-company install scoping.** `--scope user` is deliberate. A plugin is
  installed by the person who wants it, on the machine they want it on;
  separation between businesses is credentials and the gate.

**Rejected alternatives for the brain.** Considered, and rejected — do not
re-derive:

- **Notion-style databases and views** — a second source of truth beside git,
  invisible to `grep` and to the agent.
- **Embeddings or RAG by default** — at hundreds of documents, a frontier model
  plus a bounded context map plus `grep` wins. Revisit past thousands per brain.
- **Typed knowledge-graph ontologies** — a schema nobody maintains.
- **Block references and transclusion** — plain markdown stops being plain.
- **Graph-view visualization** — the backlinks panel is the useful 10% of it.

**The freeze list.** These are the product's kernel, verified correct-minimal.
Change one only with a specific reason, and expect to re-verify the others:

- **Context injection** — the marker-block `@./company-context.md` import in
  `.claude/CLAUDE.md`, byte-compare idempotent writes, git-excluded as derived state.
- **The gate** — the rule grammar, enforcement fully delegated to the agent
  runtime, receipt-based merge that retires only BuildEx-written rules, plugin
  ask/deny folding, and the fallback to the shipped preset.
- **CLI delegation** — installs, uninstalls and marketplace-add go through the
  agent's `claude` CLI; `installed_plugins.json` is the sole install-state truth.
- **Brain core** — the deterministic scan, pathspec-scoped save and history
  (`git add/commit -- <pathspec>`), the opt-in scaffold, removal backups, and
  front-matter round-tripping.
- **The external-brain subsystem and roster governance.**
- Recorded and closed: no sync service, telemetry fails closed, the star-nag is
  disabled at the call site rather than inside the module.

## Verification

Measured on 2026-08-01 at the end of the audit unless noted.

| Gate | Result |
|---|---|
| `pnpm run typecheck` (3 projects) | exit 0 |
| `pnpm run lint` | only the pre-existing upstream Ghostty localization failure |
| BuildEx unit tests (71 files matching `buildex`) | 668 passed, 0 failed |
| `tests/e2e/buildex-surfaces.spec.ts` | 15/15 in real headless Electron |
| Full unit suite (~37 000 tests) | last full fan-out was Task 13's; only the recorded upstream baseline fails. Not re-run for a docs change — see the flaky-suite note below |
| Modified upstream files | **102** (56 structural/identity + 46 interceptor-floor test files), down from 213 before WP-7 |
| Rebase drill vs live upstream | 388 commits / 5.2 days: **19 conflict stops, 26 files, 5 needing judgment** (the earlier "3× clean" drills were against days-old gaps and 1-2 commits) |

**The e2e spec needs a fresh `--mode e2e` build in front of it.** `SKIP_BUILD=1`
alone reuses whatever is in `out/`, so a main-process change can pass green
without ever being loaded, and a tree built without `--mode e2e` has no
`window.__store` for the specs to read — every one of them hangs and times out.
Build first, then `SKIP_BUILD=1`. The full recipe is in `BUILDEX-PATCHES.md`.

The e2e run writes its screenshots to `.buildex-proofs/`; that directory is
gitignored working output, not a checked-in record.

## The gate: what is done and what is not

Done, and real today: the preset, the policy engine, and the write into
`.claude/settings.json`. That is what makes an `ask` rule actually stop a call —
the agent runtime reads that file and puts the question to the operator itself.

Not done, and **won't-build for v1**: **inline approval cards and the activity
ledger.** Those need the PreToolUse hook to block on a BuildEx decision, and that
is the one piece with a real hazard attached:

> Orca installs its managed hooks to **`~/.orca/agent-hooks/`** and
> **`~/.claude/settings.json`** — both global, both shared with the Orca you run
> every day. Two instances arbitrate ownership with a lock, so nothing corrupts,
> but whichever holds it receives the hook traffic. Wiring BuildEx's own gate
> hook into that shared state can take hook telemetry away from your real Orca.

The terminal's own ask prompt is the approval card in the meantime. If the cards
are ever built, they need a decision first: give BuildEx its own hook identity and
config dir, or share Orca's and accept the interference. The same caveat applies
to simply *running* this fork alongside Orca today — it has not been launched
outside the isolated e2e profile.

The gate is not applied lazily. It lands at four moments: when a worktree is
**created** (`createManagedWorktree` awaits `prepareCompanyWorktree`, which also
writes the company context and relinks the brain's skills), when a worktree is
**activated** — the first terminal spawned in a checkout, which is the one
main-process moment every path shares, since activation itself is renderer
state — when an **automation dispatches** into an existing worktree, and when a
BuildEx surface touches a repo. Installing an app re-gates every company opened
this run, not only the one whose Store was open. **All four are local-only** — see
Known gaps below for why a checkout on an SSH host reaches none of them.

The context scan is awaited but bounded (`COMPANY_CONTEXT_DEADLINE_MS`, 10 s): it
spawns git, and no brain is worth failing to create a worktree over. An expiry
degrades to "no context", logs to the console only, and is therefore invisible in
an automation's run history.

## One brain per company, across N worktrees

An embedded `.buildex/` is **branch content**. Left alone, N parallel agent
worktrees each read the snapshot their branch was cut from and each saved onto
that branch — so the brain fragmented exactly when the operator parallelised,
which is the whole point of running businesses side by side.

The rule now: **from any checkout, an embedded brain is the primary checkout's
`.buildex/`.** One resolver answers it (`embeddedBrainCheckout` in
`brain-location.ts`, over `worktree-primary-checkout.ts` — the same aliasing
pointers, bindings and `resolveCompanyIdentity` already use), so two worktrees
read the same documents and a save from either lands as a commit on the **primary
checkout's** branch, never on a feature branch that may never merge.

Three shapes, and all three are tested:

- **Primary checkout** — its own `.buildex/`, unchanged.
- **Linked worktree** — the primary checkout's.
- **Folder workspace that is no checkout** — its own. There is no primary
  checkout to converge on and nothing is guessed at. Same answer for a worktree
  of a bare repo, and for one whose main clone has moved off this machine.

**One exception, and it is about not losing anybody's writing.** Before this
rule, every save from a worktree landed on that worktree's branch — so the
population upgrading into convergence is precisely "worktrees holding documents
the primary checkout has never seen". Sending those to a brainless primary would
orphan them: the brain would read as empty, and the placement screen would offer
*Point at an existing brain* ("nothing to move") instead of *Move brain to its
own repo*, so they could not even be moved out. A checkout that has a brain
therefore keeps it while the primary has none, and converges the moment the
primary has one. "Has a brain" is `isBrainInitialized`, not the folder existing:
a `.buildex/` holding only the gate preset is BuildEx having run there, not the
company's writing.

Where a *placement decision* is recorded — a `.buildex/brain.json` pointer, a
machine-local binding — is always the primary checkout, including one made from
a worktree. The fallback that finds them reads worktree then primary and never
the reverse, so a decision left in a worktree is visible from that worktree alone
while every sibling carries on resolving somewhere else. That is the same
split-brain by another door, and it applies to *Move brain to its own repo* and
*Point at an existing brain* alike.

Saving is still **pathspec-scoped**: `git add -- .buildex` then
`git commit -- .buildex`, which is a partial commit, so half-written code in the
primary checkout stays uncommitted and anything else the operator had staged
stays staged. That guarantee matters more now, not less, because the commit
lands in a checkout they are not looking at.

Two things a checkout can be in the middle of, failing in opposite directions,
and `checkout-commit-block.ts` answers for both:

- **A merge, rebase, cherry-pick or revert.** Git refuses a partial commit, but
  the `git add` in front of it does not — so an unguarded write leaves the brain
  staged inside a conflicted index for the commit that finishes that merge to
  sweep up.
- **A detached HEAD** — including `git bisect` and a checked-out tag. The
  reverse: git accepts the commit, nothing warns, and it is unreachable the
  moment the operator checks a branch out again.

Save, brain removal and migration all check the target checkouts first and refuse
with the reason and the path, rather than half-running. Migration checks all
three checkouts it can write to, and does it **before the backup**: catching its
own commit failure afterwards is exactly what would leave a staged deletion
behind while it deleted the files and reported success.

One knock-on worth knowing: `.claude/skills/<name>` is a symlink into the brain,
and it used to be written relative whenever the mode was embedded — "relative
inside the repo so a clone or a move keeps working". Embedded no longer implies
inside the repo, so the test is now containment. From a worktree the link is
absolute; a relative one would read `../../../acme/.buildex/skills/x`, escape the
checkout, and — if `.claude/skills/` is tracked — resolve in a teammate's clone
to whatever happened to sit beside it.

**If you run many worktrees at once, prefer an external brain.** Convergence
makes embedded mode correct, not free: every save serialises on one checkout, it
is blocked whenever that checkout is mid-rebase, and the brain's history is
interleaved with the company's code history on one branch. A brain in its own
repo (*Move brain to its own repo*, or *In a separate brain repo* at setup) has
none of those: it is outside every branch, so no worktree can be looking at a
stale copy, saves never touch the code repo's index, and it can be shared by
every repo the business opens. Embedded remains the right default for one
checkout and one operator.

## Known gaps and footguns

Each of these is understood, deliberate where it says so, and none of them is a
bug report waiting to be filed again.

**Nothing gates a checkout on an SSH host from this machine.** A worktree path
carries no host awareness, and a local directory that happens to share
`/home/ubuntu/acme` is a different directory — writing there would gate something
unrelated and still leave the real checkout ungated. So the activation hook and
the automation dispatch both no-op on a non-null `connectionId`, and worktree
*creation* on a remote repo returns through `createManagedRemoteWorktree` well
before the gate call. The BuildEx surfaces are no help either: `initializeCompanyRepo`
takes a path and no connection, and the brain resolver stats the local filesystem.
**Gating a remote checkout needs a writer on the far side that BuildEx does not
have.** Schedule SSH automations knowing they run ungated and without company
context.

**A skill copied for Windows outlives both pruning and disconnect.** Where
`symlinkSync` throws — an unprivileged process on Windows without developer
mode — the skill is *copied* into `.claude/skills/` instead. A copy is an
ordinary directory, and both `pruneDanglingSkillLinks` and `unlinkBrainSkills`
only ever touch a symlink they can prove is ours. Three consequences, and the
third is the one that matters: a copy is never refreshed when the brain's skill
changes; a skill **deleted** from the brain keeps loading; and **disconnecting a
repo leaves that company's skills active in the agent**. Company material
outliving an explicit disconnect is the sharp edge here. Telling our copy from a
skill the operator wrote by hand needs a receipt this deliberately does not keep —
closing it means keeping one, not tightening the prune.

**Nothing says which checkout a save landed in.** Since convergence, a save from a
worktree commits in the primary checkout — a directory the operator is not looking
at — and since the migration fix there are now two legitimate answers, because
where a brain *lives* and where a placement *decision* is recorded are resolved
separately. The Brain shows the save; it does not show the checkout. Recorded as
known: the affordance is missing, not broken.

**The Portfolio has no divergence column.** The audit asked for a diverged flag on
external brains. There is no read-only route to one from existing IPC —
`buildexBrain.pull` is a mutation and would be fanned out over N businesses, and
`git:status` on a **local** path goes through `resolveRegisteredWorktreePath` and
refuses anything that is not a registered worktree or repo root, which an external
brain repo never is. (The SSH branch of that handler skips the check and hands the
path to the connection's provider — irrelevant here, since an external brain on
this machine is exactly the local case.) The column reports **where the brain lives
and whether this machine has it** instead (`In repo` / `Own repo` / `Shared` /
`Not cloned here` / `Brain missing` / `Not a git repo`), which is true without a
network call. A deliberate substitution; adding divergence needs a read-only
ahead/behind IPC first.

**Two Store strings in `en.json` still describe the pre-marketplace Store.**
`buildex.store.shelf.catalogEmptyTitle` and `.catalogEmptyHint` say the indexes
that ship with the app could not be read and tell the operator to reinstall — but
indexes are fetched now, so the real cause is the network, which is what the
source fallbacks say. **The catalog value is what renders**, so the source is not
the fix. Seven further `buildex.store.page.*` keys ("Skill packs you install are
written into your company repo") are orphaned and render nowhere. Correcting them
is the three-step hand-edit described in `BUILDEX-PATCHES.md`; the sync will not
do it. **When you fix it, delete this paragraph and the matching one in
`BUILDEX-PATCHES.md` in the same commit** — both say "still live at HEAD", and a
survivor becomes a false claim the moment the copy is right.

**`reviews/weekly-review.md` describes itself as the destination** in its HTML
comment while its seeded prompt writes a new dated file in `reviews/`. Harmless —
the prompt is the half the agent reads — but it is wrong prose in a shipped seed.

## Read before touching anything

- **`BUILDEX-PATCHES.md`** — every upstream line this fork owns, the traps, the
  rebase procedure, and the fork's exit criteria.
- **Upstream main is not green.** Gate on "no new failures", never "all green" —
  `verify:localization-coverage` fails on pristine upstream over `Ghostty`, taking
  `pnpm lint` to exit 1, and `src/relay/agent-exec-handler.test.ts` fails 2 tests.
  Run tests scoped to what you changed; this box cannot do full fanout.
- **The full suite is load-flaky here.** ~7 files (relay, ssh, pty, git
  integration, agent-hooks) fail under full fan-out and pass alone, and the set
  changes run to run. Confirm any suspected regression by re-running the file
  alone, and against `git worktree add /tmp/orca-pristine upstream/main`.

## Run it

```bash
cd ~/code/buildex-app
nvm use 24.14.0 && corepack pnpm@10.24.0 install
corepack pnpm@10.24.0 run dev
```

## Upgrading from an earlier build

Pre-1.0, BuildEx does **not** carry per-version migration shims. Three of them,
plus an unreachable settings key, were deleted in WP-8 because nothing has
written their inputs for releases, and a shim that runs on every sync forever
costs more than the one-off tidy it saves. Reading, editing, saving and syncing
a brain are unchanged. What did change: two leftover files are no longer cleaned
up and are no longer hidden, so they now count as ordinary brain content, and a
hand-edited machine-wide default is no longer honoured.

Clean each up once by hand.

**In a company repo:**

- `.buildex/company-context.md` — the agent context used to be generated here
  before it moved to `.claude/`. It is no longer deleted on sync, and it is no
  longer hidden from the brain map, so a stale one now shows up as a document.
  Delete it (it is regenerated at `.claude/company-context.md` on every sync).
- `.buildex/packs.json` — a receipt from the capability-pack era. Nothing reads
  it. It is no longer moved into a brain repo by *Move brain to its own repo*,
  and its presence alone now makes a repo read as "has a brain", so a repo whose
  `.buildex/` holds nothing else will not be offered first-time setup. Delete it.

Neither file is touched automatically, in either direction — an operator's own
file that happens to share the name is theirs. That is one application of
**invariant 8 — *nothing is ever lost***, which the code cites by number without
ever defining it: `brain-remove.ts:20` for the removal backups, `BrainDocument.tsx:15`
for saving on ⌘S, Back and unmount, and `company-context.test.ts:586` and
`gate-settings.ts:125` for this one, an operator's own file being theirs whatever
it is called. (Orca's source-control code uses a separate numbering; its "design
invariant 8" is unrelated.)

A `.mcp.json` written by an older BuildEx is the exception: it *is* cleaned up,
because leaving it would show the agent every app twice. `legacy-mcp-config-cleanup.ts`
removes only the servers BuildEx generated, from a fixed list of the old pack
roster, and deletes the file only when nothing else was left in it.

**On this machine:**

- `defaultBrainPath` in `<userData>/buildex-brains.json` — a machine-wide
  fallback brain for any repo with no pointer and no binding of its own. No
  surface ever wrote it, so only a hand edit can have set it. It is now ignored:
  a repo that relied on it resolves to its own embedded `.buildex/`
  instead, which means the real brain silently stops appearing there and setup
  is offered as though the repo had none. **This fails quietly — there is no
  error.** Point each affected repo at the brain explicitly: on that setup
  screen pick *In a separate brain repo* and give it *Path to the brain repo*,
  which binds this repo alone, or add a remote as well so the pointer is
  committed to `.buildex/brain.json` and every checkout and teammate finds it.

  The key is also dropped on read, so the next write of that file removes it —
  copy the path out before reinstalling an older build, because reverting the
  app will not bring it back.

## Blocked on you

**Pushing.** `github.com/dejankeri/buildex` is your existing public BuildEx
monorepo (MIT, product content, its own history). This fork shares no history
with it, so a push is rejected as non-fast-forward and the only way to force it
would destroy that repo's history. Not something to do on an inferred instruction.

Options, cheapest first:

1. **New repo** — e.g. `dejankeri/buildex-app`; change one constant in
   `src/shared/buildex-release.ts` and the electron-builder `publish` block.
2. **Reuse `dejankeri/buildex`, monorepo archived first** — rename the existing
   repo to `buildex-monorepo` (GitHub redirects the old URL), then create
   `buildex` fresh for the app. Keeps the name, loses nothing.
3. **Replace the monorepo in place** — force-push over it. Destroys its history,
   README, `packs/`, `apps/`, and breaks anyone's fork or clone. Only if you
   consider the monorepo dead and say so explicitly.

Release config currently points at `dejankeri/buildex` per your instruction. The
repo has no matching releases, so update checks 404 and apply nothing — fail-safe
until you decide.

## Still open

- **Signing** — Windows signing is donated to Orca by SignPath; you need your own
  Apple Developer ID and Windows certificate before shipping installers.
- **CLI binary** — still `orca` internally (`bin.orca` is required by the
  `verify:cli-bin` gate). Nothing is globally linked, so no PATH clash today.
- **Linux and Windows downloads** — both still run from source.
</content>
