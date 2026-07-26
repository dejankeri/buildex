# BuildEx on Orca — progress

Fork: `~/code/buildex-app`, branch `buildex/phase-0-identity`, **local only — nothing pushed**.
Tracking `upstream/main` = `github.com/stablyai/orca`.

## Status

| Phase | Status |
|---|---|
| 0 — toolchain, isolated clone, identity before first launch | ✅ |
| 0.5 — seam spike + rebase drill (**GO/NO-GO**) | ✅ **GO** |
| 1 — release feed, bundle IDs, branding, icons, star-nag off | ✅ |
| 2 — Brain panel: deterministic map of the company repo | ✅ |
| 3 — Store, capability packs, Apps | ✅ |
| 4 — auto-feed company context to the agent | ✅ |
| 5 — sync | ✅ *by decision — see below* |

## Phase 5: why there is no sync code

Orca already ships commit, push, pull, branch management, and PR review, and the
Brain panel surfaces uncommitted documents. The company repo is a git repo, so
sync is `git push`. Building a second sync path would duplicate a surface the
operator already has and add a state machine that can disagree with git.

If a cloud sync is ever wanted, it belongs behind the existing remote, not beside it.

## What works

- **Company Brain** (right panel) — every markdown document, the link graph from
  `[[wikilinks]]` and relative links, folder grouping, orphan detection, unsaved
  markers, live filter. Deterministic: same repo in, byte-identical output.
- **Store** — reads capability packs from the repo's catalog, installs by writing
  skill scaffolds into the repo. Never overwrites an existing skill.
- **Apps** — installed packs with an app face, opening externally.
- **Agent context** — writes `.buildex/company-context.md` and an `@`-import into
  `CLAUDE.md`, so the next agent session starts knowing the company.
- **Everything Orca does** — untouched. Worktrees, terminals, diffs, agents, SSH.

## Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` (3 projects) | exit 0 |
| `pnpm lint` | only the pre-existing upstream Ghostty failure |
| BuildEx unit tests | 39 passed (brain 15, packs 12, rows 12) |
| `tests/e2e/buildex-surfaces.spec.ts` | 6/6 in real headless Electron |
| Rebase drills vs live upstream | 3× clean, zero conflicts |

Screenshots in `.buildex-proofs/`. Baseline in `.buildex-proofs/UPSTREAM-BASELINE.md`.

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
