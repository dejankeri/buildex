# BuildEx on Orca — progress

Fork: `~/code/buildex-app`, branch `buildex/phase-0-identity`, local only (no remote, nothing pushed).
Tracking `upstream/main` = `github.com/stablyai/orca`.

## Done

| Phase | Status |
|---|---|
| 0 — toolchain, isolated clone, identity before first launch | ✅ |
| 0.5 — seam spike + rebase drill (**GO/NO-GO**) | ✅ **GO** |
| 1 — release feed, bundle IDs, branding, star-nag off | ✅ |
| 2 — Brain panel, real | ▢ next |
| 3 — Apps + skill packs + Store | ▢ |
| 4 — auto-feed company context to the agent | ▢ |
| 5 — sync (thin; git remotes) | ▢ |

## The go/no-go result

Two rebase drills against live upstream: **clean, zero conflicts** both times.

Upstream footprint is ~30 files, nearly all 1–3 line registrations. The largest
single win: extracting sidebar entries to `BuildExNavEntries.tsx` took
`SidebarNav.tsx` from a ~50-line diff to **3 lines**. Follow that pattern.

## Verification

| Gate | Result |
|---|---|
| `pnpm typecheck` (3 projects) | exit 0 |
| `pnpm lint` | only the pre-existing upstream Ghostty failure |
| Scoped tests (star-nag, updater, startup, speech, attribution, notifications) | 41 files / 463 passed |
| Full suite | 36854 passed; all 7 BuildEx-caused failures fixed |
| `tests/e2e/buildex-surfaces.spec.ts` | 3/3, real headless Electron |

Screenshots: `.buildex-proofs/phase-0.5/`. Baseline: `.buildex-proofs/UPSTREAM-BASELINE.md`.

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

## Open decisions for you

1. **GitHub repo.** Nothing is pushed. `src/shared/buildex-release.ts` and
   electron-builder point at `dejankeri/buildex-app`, which does not exist — that
   is fail-safe (update checks 404 rather than installing Orca). Creating and
   pushing needs your go-ahead.
2. **CLI binary.** Still `orca` internally; `bin.orca` is hard-required by the
   `verify:cli-bin` gate. Nothing is globally linked so there is no PATH clash
   today. Adding a `buildex` alias is a Phase 2 nicety.
3. **Signing.** Windows signing is donated to Orca by SignPath; you need your own
   Apple Developer ID and Windows certificate before shipping installers.
4. **Icons.** Still Orca's artwork in `resources/build/`. Replace before any
   public build — the code identity is BuildEx, the pixels are not.
