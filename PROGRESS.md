# BuildEx on Orca — progress

Fork: `~/code/buildex-app`, branch `buildex/phase-0-identity`, **local only — nothing pushed**.
Tracking `upstream/main` = `github.com/stablyai/orca`.

## Status

| Phase | Status |
|---|---|
| 0 — toolchain, isolated clone, identity before first launch | ✅ |
| 0.5 — seam spike + rebase drill (**GO/NO-GO**) | ✅ **GO** |
| 1 — release feed, bundle IDs, branding, icons, star-nag off | ✅ |
| 2 — Brain: full-screen surface over `.buildex/`, edited in place | ✅ |
| 3 — Store, capability packs, Apps | ✅ |
| 4 — auto-feed company context to the agent | ✅ |
| 5 — sync | ✅ *by decision — see below* |
| 6 — shipped catalog: Store works on first run | ✅ |
| 7 — gate: allow/ask/deny, enforced by the agent runtime | ✅ *engine + settings; approval cards blocked — see below* |

## Phase 5: why there is no sync code

Orca already ships commit, push, pull, branch management, and PR review, and the
Brain panel surfaces uncommitted documents. The company repo is a git repo, so
sync is `git push`. Building a second sync path would duplicate a surface the
operator already has and add a state machine that can disagree with git.

If a cloud sync is ever wanted, it belongs behind the existing remote, not beside it.

## What works

- **Company Brain** (left rail, full screen) — nine sections over `.buildex/`
  with coverage bars, the skills the company wrote and the ones its apps brought,
  and history of every save. Documents are written **in the Brain** with the app's
  own rich markdown editor; YAML front matter is held back from the editor and
  put back byte for byte, so a skill's `name:` and `description:` survive editing.
  Deterministic: same repo in, byte-identical output.
- **Store** — reads capability packs from the repo's catalog, installs by writing
  skill scaffolds into the repo. Never overwrites an existing skill.
- **Apps** — installed packs with an app face, opening externally.
- **Agent context** — writes `.claude/company-context.md` and an `@`-import into
  `.claude/CLAUDE.md`, so the next agent session starts knowing the company.
  Refreshed automatically whenever the map can have changed: the Brain opening, a
  document created, an app installed or removed. There is no button — a context
  someone has to remember to refresh is a context that is usually wrong. Both
  files sit in `.claude/`, git-excluded: this is derived machine state, so
  committing it would churn the company's history for nothing. A tracked
  `company-context.md` left by an older build is removed on sight, but only when
  it carries our generated header.
- **Store, on first run** — 11 capability packs (Slack, Stripe, Linear, Notion,
  HubSpot, Asana, Calendly, Canva, Intercom, HeyGen, Protocol) ship inside the
  app, so a repo with no catalog of its own still has a full shelf. A repo
  catalog overrides a shipped pack by id. App updates re-sync installed packs;
  files the operator edited are kept and reported, never overwritten.
- **The gate** — the allow/ask/deny preset is written into the company repo's
  `.claude/settings.json`, so the agent's own runtime enforces it. Wide
  autonomy: reading, editing, searching, shell and web run without interruption;
  `rm -rf`, force-push and `reset --hard` wait for a person. A company can
  override the preset in `.buildex/gate-preset.json`; a broken override falls
  back to the shipped one rather than to no gates.
- **Everything Orca does** — untouched. Worktrees, terminals, diffs, agents, SSH.

## Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` (3 projects) | exit 0 |
| `pnpm lint` | only the pre-existing upstream Ghostty failure |
| Full unit suite | 37 014 tests; only the recorded upstream baseline fails |
| BuildEx unit tests | 114 passed (brain, packs, gate, store) |
| `tests/e2e/buildex-surfaces.spec.ts` | 8/8 in real headless Electron |
| Rebase drills vs live upstream | 3× clean, zero conflicts |

Screenshots in `.buildex-proofs/`. Baseline in `.buildex-proofs/UPSTREAM-BASELINE.md`.

## The gate: what is done and what is not

Done, and real today: the preset, the policy engine, and the write into
`.claude/settings.json`. That is what makes an `ask` rule actually stop a call —
the agent runtime reads that file and puts the question to the operator itself.

Not done: **inline approval cards and the activity ledger.** Those need the
PreToolUse hook to block on a BuildEx decision, and that is the one piece with a
real hazard attached:

> Orca installs its managed hooks to **`~/.orca/agent-hooks/`** and
> **`~/.claude/settings.json`** — both global, both shared with the Orca you run
> every day. Two instances arbitrate ownership with a lock, so nothing corrupts,
> but whichever holds it receives the hook traffic. Wiring BuildEx's own gate
> hook into that shared state can take hook telemetry away from your real Orca.

So the approval-card half needs a decision before it is built: give BuildEx its
own hook identity and config dir, or share Orca's and accept the interference.
Worth noting the same caveat applies to simply *running* this fork alongside
Orca today — it has not been launched outside the isolated e2e profile.

Also outstanding: the gate is applied the first time a BuildEx surface touches a
repo, not the instant a worktree opens. A worktree-activation trigger is upstream
surface this fork has deliberately kept thin.

## Read before touching anything

- **`BUILDEX-PATCHES.md`** — every upstream line this fork owns, the traps, the rebase procedure.
- **`.buildex-proofs/UPSTREAM-BASELINE.md`** — upstream main is not green. Gate on
  "no new failures", never "all green". Run tests scoped; this box cannot do full fanout.

## Run it

```bash
cd ~/code/buildex-app
nvm use 24.14.0 && corepack pnpm@10.24.0 install
corepack pnpm@10.24.0 run dev
```

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
- **Pack MCP faces** — parsed and carried, but installing does not yet write
  `.mcp.json`. Skills install; MCP wiring is the next increment.
