# BUILDEX-PATCHES.md

Every line this fork changes in an **upstream-owned file**. Read this before any
`git rebase upstream/main`; it is the map for resolving conflicts fast.

**The rule:** BuildEx code lives in new files. An upstream file may only gain a
*registration* — an import, a union member, a render line. If you are writing
logic inside an upstream file, stop and extract it to a BuildEx-owned file.

Worked example: the sidebar nav entries started as ~50 inline lines in
`SidebarNav.tsx`; extracting them to `BuildExNavEntries.tsx` took that file's
diff to **3 lines**. Do that every time.

---

## BuildEx-owned files (zero conflict risk)

```
src/renderer/src/components/right-sidebar/BrainPanel.tsx
src/renderer/src/components/sidebar/BuildExNavEntries.tsx
src/renderer/src/components/buildex-apps/AppsPage.tsx
src/renderer/src/components/buildex-store/StorePage.tsx
tests/e2e/buildex-surfaces.spec.ts
BUILDEX-PATCHES.md
```

## Upstream files touched

### Identity — Phase 0

| File | Change |
|---|---|
| `package.json` | `name`, `description`, `homepage`, `author`. **`bin` deliberately unchanged** — `bin.orca` is hard-required by `config/scripts/verify-cli-bin.mjs` |
| `config/electron-builder.config.cjs` | `appId` → `com.buildex.app`, `productName` → `BuildEx` |
| `src/main/startup/dev-instance-identity.ts` | `BASE_APP_NAME`, `BASE_APP_USER_MODEL_ID` |
| `src/main/startup/configure-process.ts` | dev userData dir `orca-dev` → `buildex-dev` |
| `config/scripts/run-electron-vite-dev.mjs` | same dir constant |
| `config/scripts/orca-dev.mjs` | same dir constant |
| `config/scripts/computer-use-smoke.mjs` | same dir constant |
| `src/main/observability/logs-directory.ts` | log dir no longer `Application Support/Orca` |
| `src/main/speech/model-cache-path.ts` | speech cache dir |
| `src/main/startup/dev-instance-identity.test.ts` | 5 expectations |
| `src/main/startup/configure-process.test.ts` | 1 expectation |
| `src/main/speech/model-manager-windows-path.test.ts` | 1 expectation |

> **These four move together.** The dev launchers write CLI wrappers into
> `<userData>/cli/bin`. Changing the main process alone points the app at
> `buildex-dev` while wrappers land in `orca-dev`.

### Release, bundle IDs, attribution — Phase 1

| File | Change |
|---|---|
| `src/shared/buildex-release.ts` | **BuildEx-owned.** Single source of truth for the release repo |
| `src/main/updater.ts` | import + 2 feed URLs |
| `src/main/updater-prerelease-feed.ts` | atom feed, download base, tag regex |
| `config/electron-builder.config.cjs` | `publish` owner/repo; linux `packageName`/`artifactName` |
| `src/main/ipc/notifications.ts` | `MACOS_PACKAGED_BUNDLE_ID` |
| `src/main/computer/macos-computer-use-permissions.ts` | computer-use bundle ID |
| `config/scripts/{run-electron-vite-dev,build-notification-status-macos,build-computer-macos}.mjs` | bundle IDs |
| `native/computer-use-macos/.../main.swift` | sidecar peer allowlist |
| `src/main/window/createMainWindow.ts` | window title ×2 |
| `src/main/tray/system-tray.ts` | tray label |
| `src/main/attribution/terminal-attribution.ts` | PR/issue footers (written into *other people's* repos) |
| `src/main/index.ts` | do not call `starNag.start()` |
| `src/main/updater.test.ts`, `src/main/updater-prerelease-feed.test.ts` | URL fixtures |

**Telemetry needs no patch.** It fails closed — `ORCA_BUILD_IDENTITY` and
`ORCA_POSTHOG_WRITE_KEY` are injected by upstream CI and resolve to `null` in a
fork build, so it cannot transmit. Do not "fix" this by pointing it somewhere.

### Brain, packs, context — Phases 2-4

| File | Change |
|---|---|
| `src/shared/buildex-brain-types.ts`, `buildex-packs-types.ts` | **BuildEx-owned** wire contracts |
| `src/main/buildex-brain/*`, `src/main/buildex-packs/*` | **BuildEx-owned** domain layers |
| `src/main/ipc/buildex-brain.ts`, `buildex-packs.ts` | **BuildEx-owned** IPC modules |
| `src/main/ipc/register-core-handlers.ts` | 2 imports + 2 registration calls |
| `src/preload/index.ts` | 2 type imports + 2 api namespaces |
| `src/preload/api-types.ts` | 2 type imports + 2 members on `PreloadApi` |
| `resources/build/icon.{png,icns,ico}`, `resources/{icon,icon-dev}.png`, `resources/logo.svg` | BuildEx artwork |

### Surfaces — Phase 0.5

| File | Change |
|---|---|
| `src/shared/types.ts` | `'brain'` on `RightSidebarTab`; `'apps' \| 'store'` on `TopLevelView` |
| `src/shared/top-level-view.ts` | `Record<TopLevelView, true>` entries |
| `src/renderer/src/store/right-sidebar-route.ts` | `'brain'` in the runtime allowlist |
| `src/renderer/src/store/slices/ui.ts` | 8 `previousViewBefore*` unions; `previousViewBeforeApps/Store` + 4 open/close actions |
| `src/renderer/src/hooks/resolve-zoom-target.ts` | `activeView` union |
| `src/renderer/src/components/right-sidebar/index.tsx` | `Brain` icon import + 1 activity item |
| `src/renderer/src/components/right-sidebar/right-sidebar-panel-content.tsx` | lazy import + 1 render line |
| `src/renderer/src/components/sidebar/SidebarNav.tsx` | **3 lines**: import + `<BuildExNavEntries />` |
| `src/renderer/src/App.tsx` | 2 lazy imports + 2 render lines |
| `src/renderer/src/i18n/locales/{en,es,ja,ko,zh}.json` | 12 `buildex.*` keys, generated |

---

## Traps found the hard way

**1. Typecheck does not find every registration site.**
`normalizeRightSidebarRoute()` validates the tab against a *runtime string
allowlist* and silently rewrites unknown values to `'explorer'`. The Brain tab
compiled, rendered its button, and quietly did nothing when clicked. Only an
end-to-end launch caught it. **After adding a surface, always run
`tests/e2e/buildex-surfaces.spec.ts`.**

**2. `previousViewBefore*` are hand-duplicated unions, not `Exclude<>`.**
Eight copies of `TopLevelView` minus one member. Every new BuildEx view costs 8
edits. *Candidate refactor:* rewrite them as `Exclude<TopLevelView, 'x'>` to make
future views free — deferred because it rewrites upstream declarations, and the
conflict cost of that rewrite may exceed the 8 edits it saves.

**3. Brain must not be the first activity item.**
`resolveRightSidebarEffectiveTab` falls back to `visibleItems[0]`. Leading with
Brain would displace Explorer as the default and degrade the developer workflow
this fork intends to keep.

**4. E2E specs are CJS.** Use `__dirname`, not `import.meta.dirname`.

**4a. `config/*.tsbuildinfo` goes stale.** After editing
`src/preload/api-types.ts`, `pnpm typecheck` can report a phantom
"Property does not exist on type 'PreloadApi'". The files are gitignored —
delete them, or confirm with `pnpm run typecheck:tsc:web` (composite off).

**4b. `Orca` and `orca` are the same directory.** Verified on this machine:
`~/Library/Application Support/Orca` and `.../orca` share inode `142205264`.
APFS is case-insensitive by default, so any fork still named `orca` writes into
the user's real Orca profile. This is why identity must be renamed *before the
first launch*, not in a later branding pass.

**4c. Disable features at the call site, not inside the module.** Gating
`shouldShowStarNagThresholdPrompt` internally broke 20+ star-nag tests for no
benefit. Skipping `starNag.start()` in `index.ts` disables the nag, keeps IPC
handlers registered, and leaves the module's suite fully green.

**5. i18n is nearly free.** `pnpm run sync:localization-catalog` generates every
key across all five locales. Run it before `pnpm lint`.

---

## Rebase procedure

```bash
git fetch upstream
git rebase upstream/main
pnpm install                  # lockfile may have moved
pnpm run typecheck            # must exit 0
pnpm run sync:localization-catalog
pnpm run lint                 # expect ONLY the pre-existing upstream Ghostty localization failure
SKIP_BUILD=1 pnpm exec playwright test tests/e2e/buildex-surfaces.spec.ts \
  --config tests/playwright.config.ts --project=electron-headless --workers=1
```

Rebase **weekly**. At ~20 touch points of 1-3 lines each it is a 10-minute job;
let it slide a month and the renderer will have moved underneath you.

Drill result 2026-07-26: rebased 2 commits across 1 upstream commit — **clean, zero conflicts**.

## Traps found while shipping the catalog and the gate

**Scoped test runs hide regressions.** Four real breakages survived weeks of
scoped runs and only surfaced when the full 37 000-test suite ran: the updater
readiness tests mocked upstream's atom feed, `UpdateCard` linked to Orca's
releases, the git commit trailer still said `Co-authored-by: Orca`, and
`register-core-handlers`' electron mock had no `ipcMain`. Run the whole suite
before claiming a phase is green. It takes about six minutes.

**The full suite is load-flaky on this box.** Roughly seven files (relay, ssh,
pty, git integration, agent-hooks) fail under full fan-out and pass in isolation,
and the set changes run to run. The only deterministic failure is
`src/relay/agent-exec-handler.test.ts` (2 tests), which also fails on a pristine
`upstream/main` worktree. Confirm any suspected regression by re-running the file
alone, and against `git worktree add /tmp/orca-pristine upstream/main`.

**Two lint gates fail silently behind the first.** `pnpm lint` is a chain of
`&&`, so the Ghostty localization failure at the end masks nothing — but
`check-styled-scrollbars` sits *before* it and had been failing on the three
BuildEx surfaces. Read the whole log, not the tail.

**The Windows ICO has a fill gate.** `resources/build/icon.ico` must fill ≥92% of
its largest frame. Do not hand-build it — run
`node config/scripts/trim-windows-icon-source.mjs`, which derives it from
`resources/build/icon.png`.

**Initializing a repo from two entry points needs one resolver.** The Brain and
the Store both call `initializeCompanyRepo`, which is once-per-repo-per-run. An
early version let the Brain pass `null` for the bundled catalog root and then
mark the repo done, silently skipping the pack refresh the Store would have run.
The root is resolved inside the module now; keep it that way.

**Hook state is global and shared with the operator's real Orca.** Managed hooks
install to `~/.orca/agent-hooks/` and `~/.claude/settings.json` — not to
userData. Anything this fork does with agent hooks reaches the Orca they run
every day. This is why the gate is enforced through the repo's
`.claude/settings.json` (project-scoped, ours alone) rather than a PreToolUse
hook.
