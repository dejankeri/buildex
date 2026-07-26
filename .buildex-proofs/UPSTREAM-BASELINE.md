# Upstream baseline — measured, not assumed

Fork point: `b168f6f100` → rebased onto `5d17bd8f33` (upstream/main, 2026-07-26)

Upstream main is **not green**. Every phase gate is therefore "no NEW failures
against this baseline", never "all green". Each claim below was verified by
running the same test on a pristine `upstream/main` git worktree.

## 1. Pre-existing upstream failures (reproduced on pristine upstream)

**`pnpm run verify:localization-coverage`** — fails on unmodified upstream:

```
src/renderer/src/components/settings/terminal-advanced-platform-search.ts:66,67,105,106  "Ghostty"
src/renderer/src/components/settings/terminal-pane-appearance-search.ts:89,90            "Ghostty"
```

Consequence: `pnpm lint` always exits 1. Every step *before* this one passes,
so lint stays a usable gate for oxlint, switch-exhaustiveness, reliability
gates, max-lines ratchet, and the localization catalog.

**`src/relay/agent-exec-handler.test.ts`** — 2 tests fail identically on
pristine upstream (verified via `git worktree add /tmp/orca-pristine upstream/main`):

```
AgentExecHandler > executes a non-interactive command with captured output and stdin
AgentExecHandler > merges caller-supplied provider environment into the spawned command environment
```

## 2. Load-related flakes (pass in isolation, fail under full fanout)

This machine cannot run all 3455 test files at full concurrency; workers fail to
start (`[vitest-pool]: Failed to start forks worker`) and slow suites time out.
These all pass when run isolated:

- `src/main/agent-hooks/managed-hook-install-lock.test.ts`
- `src/main/git/status-discard-symlink.test.ts` (82s under load)
- `src/relay/git-handler.test.ts` (272s under load)
- `src/main/daemon/shell-ready.test.ts`
- `src/main/daemon/terminal-history-incremental-restore.test.ts` (60s under load)

**Run tests scoped to what you changed**, not the full suite, on this box.

## 3. Failures caused by BuildEx — all fixed

The identity rename broke 7 upstream tests that pinned the old strings. Fixed by
updating the expectations (not by weakening the assertions):

- `src/main/startup/dev-instance-identity.test.ts` (5) — `Orca`/`Orca Dev`/`com.stablyai.orca`
- `src/main/startup/configure-process.test.ts` (1) — `orca-dev` userData path
- `src/main/speech/model-manager-windows-path.test.ts` (1) — `ProgramData/Orca/speech-models`

Verified: `3 files / 36 tests passed`.

## Full-suite reference numbers

| Run | Result |
|---|---|
| After Phase 0 identity | 36854 passed, 16 failed (7 mine, 2 upstream, 7 flake) |
| Typecheck (3 projects) | exit 0, clean |
| E2E `buildex-surfaces.spec.ts` | 3/3 passed |
