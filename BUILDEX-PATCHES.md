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
config/scripts/verify-buildex-macos-release-env.mjs
config/scripts/verify-packaged-asar-contents.cjs
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

### Signing and release artifacts

| File | Change |
|---|---|
| `package.json` | `version` follows BuildEx's own line (`0.1.8`), not Orca's. **Expect a conflict here on every rebase** — always keep ours |
| `package.json` | `build:mac:release` calls `verify-buildex-macos-release-env.mjs`, not upstream's |
| `config/electron-builder.config.cjs` | `dmg.artifactName` → `buildex-macos-${arch}.${ext}`; `mac.extendInfo` permission strings say BuildEx |
| `config/scripts/verify-packaged-daemon-entry.cjs` | boot-check `spawnSync` timeout 10s → 120s. Only the arm64 slice runs this check, and it is packaged while the multi-GB x64 DMG is still being written — 10s lost that race and failed a healthy build. The gate itself is unchanged |
| `config/electron-builder.config.cjs` | `files` excludes `.claude`, `.buildex`, `.mcp.json`, `test-results`; `afterPack` gains one `verifyPackagedAsarContents(resourcesDir)` line |

**`files` is a blacklist.** Anything left at the repo root ships inside
`app.asar` unless it is named there, and `.gitignore` has no bearing on it. Two
incidents on 2026-07-28 proved this the hard way: a 4.4 GB folder of previous
release artifacts parked at the root was packed into a 3.9 GB DMG and signed and
notarized before anyone noticed, and **v0.1.7 shipped this repo's own `.claude/`**
— agent settings plus a generated `company-context.md` naming a local filesystem
path — to everyone who downloaded it. No credentials were exposed and `.buildex/`
was not present, but the DMG is public. `verify-packaged-asar-contents.cjs` now
fails packaging on either shape.

Upstream's `config/scripts/verify-macos-release-env.mjs` is left untouched and
unused. It demands Apple ID + app-specific password + a base64 `.p12` in
`CSC_LINK`; this machine notarizes with an App Store Connect API key and signs
from a Developer ID in the login keychain. Both are valid — the BuildEx-owned
validator accepts either, so the upstream file never conflicts.

`config/scripts/verify-release-required-assets.mjs` still lists `orca-macos-*`
names, and `.github/workflows/homebrew-bump.yml` still greps for them. Neither
runs here: the release workflows are guarded by
`if: github.repository == 'stablyai/orca'`. Rename them if this fork ever cuts
releases from CI.

**Telemetry needs no patch.** It fails closed — `ORCA_BUILD_IDENTITY` and
`ORCA_POSTHOG_WRITE_KEY` are injected by upstream CI and resolve to `null` in a
fork build, so it cannot transmit. Do not "fix" this by pointing it somewhere.

### Brain, packs, context — Phases 2-4

| File | Change |
|---|---|
| `src/shared/buildex-brain-types.ts`, `buildex-store-types.ts`, `buildex-automation-context-types.ts` | **BuildEx-owned** wire contracts |
| `src/main/buildex-brain/*`, `src/main/buildex-store/*` | **BuildEx-owned** domain layers |
| `src/main/ipc/buildex-brain.ts`, `buildex-brain-placement.ts`, `buildex-store.ts`, `buildex-automation-context.ts` | **BuildEx-owned** IPC modules |
| `src/main/ipc/register-core-handlers.ts` | 4 imports + 4 registration calls |
| `src/preload/index.ts` | 5 type imports + 5 api namespaces |
| `src/preload/api-types.ts` | 5 type imports + 5 members on `PreloadApi` |
| `resources/build/icon.{png,icns,ico}`, `resources/{icon,icon-dev}.png`, `resources/logo.svg` | BuildEx artwork |
| `src/main/buildex-repo-init.ts`, `buildex-worktree-init.ts` | **BuildEx-owned.** Everything a repo and a fresh checkout need before an agent works there |
| `src/main/buildex-company-identity.ts` | **BuildEx-owned.** Which business a path belongs to — the key everything stored per company is filed under |
| `src/main/runtime/orca-runtime.ts` | 1 import + 1 `await prepareCompanyWorktree(created.path)` in `createManagedWorktree` |
| `src/main/runtime/orca-runtime.test.ts` | 1 import + 1 `readFileSync` import member + 2 harness mocks + 1 test |
| `src/main/ipc/pty.ts` | 2 imports + 1 `applyCompanyPluginEnv(...)` call in `buildPtyHostEnv` + 1 `buildexWorkspacePath` field on `BuildPtyHostEnvOptions` and the `companyWorkspacePathForSpawn(ctx)` line that fills it + 1 `gateCompanyWorktreeOnActivation(worktreePath, connectionId)` in `beginPtySpawnForWorktree` |
| `src/main/providers/local-pty-provider.ts` | 2 lines: `worktreeId?: string` on the `buildSpawnEnv` ctx type + `worktreeId: args.worktreeId` where it is called |
| `src/main/index.ts` | 1 import + 1 `await prepareCompanyWorktreeForAutomationRun(automation, store)` in the headless dispatcher's existing-workspace branch |
| `src/renderer/src/lib/buildex-automation-workspace-context.ts` | **BuildEx-owned.** The renderer dispatch path's one-line ask |
| `src/renderer/src/hooks/useAutomationDispatchEvents.ts` | 1 import + 1 `await prepareAutomationWorkspaceContext(automation, worktree.id)` before the agent launch |
| `src/renderer/src/hooks/useAutomationDispatchEvents.test.ts` | 1 mock + 1 `window.api` stub member + 2 tests |

**Why the runtime is touched at all.** The automations engine creates a headless
worktree and launches the startup agent in the same call, and `.claude/` is
git-excluded — so without this line the agent runs most autonomously exactly
where it has the least memory and the fewest guardrails. It is **awaited**: Claude
Code reads `.claude/` once at session start, so the void-fired refresh the IPC
surfaces use would race the agent. Keep the logic in `buildex-worktree-init.ts`;
the runtime's share is the one call.

**Awaited is not unbounded.** The context scan spawns `git status`, and it now
sits on the critical path of creating a worktree, so a wedged git would stall
worktree creation outright. `prepareCompanyWorktree` races it against
`COMPANY_CONTEXT_DEADLINE_MS` and degrades to no-context with a log line. A
broken brain must never cost a worktree.

**`new_per_run` was the example, not the boundary.** Wiring context into worktree
*creation* only reached the automations that create one — and `existing` is the
Automations UI's default, so the common scheduled run still read whatever
`.claude/` a Brain or Store interaction last happened to leave behind. Those runs
now go through `prepareCompanyWorktreeForAutomationRun`, which is the same
bounded, no-throw preparation with a workspace id in front of it. Both dispatch
paths reach it: `index.ts`'s headless branch calls it directly, and the
renderer-present hook calls it over `buildex-automation-context:prepareWorkspace`.
The renderer holds no copy of the logic — only the ask — so the two cannot drift.
The refresh runs on **every** dispatch, which for an hourly automation is an
hourly `git status` over the brain; the deadline is what keeps that bounded, and
there is deliberately no cache to go stale behind it.

**A workspace id is not a host either.** The path comes out of the worktree id,
but which machine it names comes from `store.getRepo(repoId)?.connectionId` —
the same signal `gateCompanyWorktreeOnActivation` takes. A workspace whose repo
the store cannot produce is left alone rather than written to on the chance the
path happens to be local, which is why the store travels with the request instead
of the renderer asserting the host.

**Why `pty.ts` is the activation hook.** Worktree activation is renderer state —
main never hears about it, and `ui:activateWorktree` runs the other way. The
narrowest main-process point where an agent begins working in a checkout is
`beginPtySpawnForWorktree`, which **both** spawn entry points already call
(`ipcMain.handle('pty:spawn')` for the renderer, and the runtime's pty controller
for CLI, mobile and automations) and which already holds the worktree's absolute
path. Gating there is synchronous and once per checkout per run; the context is
deliberately *not* refreshed there, because that reads git and a spawn is no
place to wait for it.

**Remote worktrees are not gated on activation.** `splitWorktreeIdForFilesystem`
returns a path with no host awareness, so for an SSH worktree it is the *remote*
filesystem's path — and a local directory that happens to share it is a different
directory. Writing there would gate something unrelated and still leave the real
checkout ungated, so `beginPtySpawnForWorktree`'s `connectionId` (non-null ⇒ SSH,
the same signal `pty.ts:1023` already keys host-loopback injection off) turns the
call into a no-op. A remote checkout's gate still lands when a BuildEx surface
touches the repo. **Gating remote worktrees needs a writer on the far side that
BuildEx does not have yet — a known gap, not an oversight.**

**A credential is keyed by company, and a worktree path is not one.** Both call
sites hand over a *worktree* path, so keying storage on it would give one
business N identities and split its keys N ways with no error to notice.
`resolveCompanyIdentity` collapses them onto the primary checkout — the same
aliasing `worktree-primary-checkout.ts` already solves for the brain. A folder
workspace outside any repo has no such aliasing and is named by its own path,
through the same slug-and-digest, so both supported workspace shapes get a key in
one format. Only a path this machine cannot see resolves to no company; that is
the SSH case, and it is deliberately not guessed at. Anything BuildEx stores per
business goes through that one resolver; a second identity mechanism would
disagree with the first on the day it matters.

**A cwd is not a workspace, and a path is not a host.** Two variants of the same
mistake, both live at the same moment. `ctx.cwd` is wherever a shell started, so
gating key injection on it gave a bare `$HOME` terminal every key on the machine;
the spawn's `worktreeId` is what says the PTY belongs to a business, which is why
`local-pty-provider.ts` now forwards it. And `repoPath` cannot say which machine
it names — SSH to a host with the same username and `/home/ubuntu/acme` exists on
both sides — so the credential IPC carries `connectionId`, exactly as
`gateCompanyWorktreeOnActivation` does. **Host identity is carried, never
inferred from a path.**

**Nothing ever writes or deletes the pre-company credential file.** Every write
lands in `pack-credentials/<companyKey>/`, which is why disconnecting is a
`<plugin>.disconnected` marker rather than a deletion: the shared file is read by
every business, so removing it would disconnect companies the operator said
nothing about, and leaving it unshadowed would reconnect the plugin the instant
they disconnected it.

**A gate write is only ever as complete as the catalogue behind it.** The rules
must come from the shelf *that company* sees — `readCompanyStoreEntries(location)`,
bundled marketplaces plus the ones its own brain adds. Deriving them from another
company's catalogue omits every app from a marketplace that catalogue never had,
and `mergeList` then retires rules the app is still relying on. This is the same
trap as syncing with no plugin rules at all, through a different door; it bit
once via `initializeCompanyRepo` reading a repo-less catalogue, and once via the
Store fanning one company's rules out to all of them.

### Branding the visible copy — Phase 6

The app calls *itself* BuildEx everywhere; it still names Orca's own products
accurately. The rule: **"Orca" survives only when it names Stably-operated
infrastructure or a literal `orca` identifier.**

| File | Change |
|---|---|
| `src/shared/buildex-brand.ts` | **BuildEx-owned.** The rule, the protection list, `brandedTranslate` |
| `src/renderer/src/i18n/i18n.ts` | import + 1 line in `translate()` |
| `src/main/i18n/main-i18n.ts` | import + 1 line in `translateMain()` |
| `src/renderer/src/components/buildex-brand/BuildExWordmark.tsx` | **BuildEx-owned.** `BUILDEX` + "built on Orca" lockup |
| `src/renderer/src/components/Landing.tsx` | import + replaces the `ORCA` `<h1>` |
| `src/renderer/src/components/settings/BuildExAttributionSection.tsx`, `buildex-attribution-search.ts` | **BuildEx-owned.** Replaces upstream's "Support Orca" star prompt |
| `src/renderer/src/components/settings/GeneralPane.tsx` | 2 import lines + 1 render line |
| 17 renderer component files | 33 **unlocalized** literals, 1 line each (see below) |
| 8 upstream settings tests | expectations realigned to the branded copy |

**Why an interceptor and not a find-and-replace.** `en.json` is *generated*:
`verify-localization-catalog.mjs` parses the source with the TypeScript API and
writes each `translate(key, fallback)` fallback into the catalog. Editing the
catalog is reverted by `sync:localization-catalog`, and editing the ~400 call
sites means touching upstream `.tsx` on every rebase. Both `translate()` and
`translateMain()` are single chokepoints, so branding there costs 4 lines and
covers `es`/`ja`/`ko`/`zh` for free.

**Brand the template, then interpolate.** `translate()` returns text *after*
interpolation, so a post-hoc rewrite would corrupt user data — a repo named
`stablyai/Orca` in `{{repo}} isn't added to Orca`. `brandedTranslate` resolves
the raw template with `skipInterpolation`, brands it, then interpolates.

**`buildex.*` keys are exempt.** Our own copy is authored, not inherited;
without the exemption the credit line "built on Orca" rebrands to "built on
BuildEx".

### Traps found while branding

**Not every visible string is localized.** 33 user-facing literals never reach
`translate()`, so the interceptor cannot see them (`notification-settings-copy.ts`,
`delete-worktree-dialog-copy.ts`, `CrashReportDialogSurface.tsx`, terminal
hints, …). These needed direct edits. Find them with: every `Orca` string
literal in source whose exact text is **absent** from `en.json`.

**Do not rebrand a `translate()` fallback.** It is catalog-managed and its
value is dead text at runtime — and upstream's catalog has already *drifted*
from some fallbacks (`OnboardingFlow.ff92d15436` says "notify you know"; the
source says "notify you"). Editing one changes nothing and costs a rebase
conflict. The filter that distinguishes them is "is this exact string a value
in `en.json`".

**Three literals look rebrandable and are not.** `Orca Nerd Font Symbols` is a
font family; `pr-comments-resolution-prompt.ts` is agent prompt text, not UI;
`displayName: 'Orca'` in `RepositoryHostSetupsSection.test.tsx` is host fixture
data.

**~380 `Orca` literals remain in `src/main/**`** — internal errors, logs, and
IPC messages. Deliberately untouched: they are plumbing, not branding, and
editing them would multiply the rebase surface.

**The dangerous class: code that string-matches its own copy.** Four places
keyed behaviour off the exact wording, so renaming the copy silently broke a
feature with no type error and no obvious test name. Each now accepts **both**
brands, which also survives upstream wording returning through a rebase:

| File | What broke |
|---|---|
| `src/shared/remote-runtime-tailscale-hint.ts` | regex gate; the Tailscale remedy stopped being offered |
| `src/shared/remote-runtime-client-error-classification.ts` | recoverable-drop fragments; reconnects would reclassify as fatal |
| `src/shared/orca-dispatch-status-prompt.ts` | preamble prefix is a **protocol handshake** with `src/main/runtime/orchestration/preamble.ts`, not display copy |
| `src/renderer/src/lib/agent-row-primary-text.ts` | second dispatch detector; agent rows lost their task labels |

Before renaming any copy, grep for code that matches it:
`grep -rnE "(includes|startsWith|indexOf|test)\(\s*['\"\`][^'\"\`]*[Oo]rca"` and
`/[^/]*\borca\b[^/]*/i` regexes. Lowercase matchers are the trap — the rebrand
rule leaves them alone, so they keep matching a string that no longer exists.

**Three sources of test breakage, in rough order of volume.** Realigning
expectations by pattern over-applies; drive it from actual failures instead.
1. Assertions on **`translate()` fallbacks** — these never appear in a source
   diff, because the interceptor rebrands them at runtime with no source edit.
2. **Non-English** expectations (`'Orca 手机端'`) — the interceptor covers all
   five locales, so `zh`/`ja`/`ko`/`es` assertions move too.
3. **Regex matchers** (`/Windows may be blocking Orca Mobile/i`) — not string
   literals, so literal-based sweeps miss them entirely.

**Never rewrite bare `'Orca'` in tests by pattern.** It is simultaneously a
catalog value *and* the most common fixture in the suite — host `displayName`,
`localAppData/Orca/daemon-host` paths, CLI install dirs. Only two assertions
genuinely wanted it branded (the tray tooltip); a blanket pass corrupted ~130.

**Tests that `vi.mock('@/i18n/i18n')` assert fallbacks, not branded output.**
About a dozen stub `translate` as `(_key, fallback) => fallback`, bypassing the
interceptor entirely, so their expectations must keep saying "Orca". Check for
the mock before changing any expectation in a test file.

**Check `git show HEAD:<file>` before bulk-reverting.** A revert pass that
rewrote every bare `'BuildEx'` back to `'Orca'` also clobbered a Phase 0
expectation (`model-manager-windows-path.test.ts`) that had been correct since
identity was renamed. Scope reverts to lines that actually differ from HEAD.

**The snapshot is the rebase gate.** `src/renderer/src/i18n/buildex-brand-catalog.test.ts`
pins every branded catalog string. Upstream copy changes surface as one
reviewable diff instead of ~400 silent ones. Read it during each rebase.

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
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/i18n/buildex-brand-catalog.test.ts   # read the snapshot diff
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
early version let the Brain pass `null` for the resource root and then mark the
repo done, silently skipping work the Store would have run. The root is resolved
inside the module now; keep it that way. The same shape bit again when the Store
became a marketplace client: `initializeCompanyRepo` synced the gate with no
plugin rules, so merely opening a surface took an installed app's `ask` rules
back out of `.claude/settings.json`. Whatever calls `syncGateSettings` must pass
`collectPluginGateRules` for what is installed.

**Hook state is global and shared with the operator's real Orca.** Managed hooks
install to `~/.orca/agent-hooks/` and `~/.claude/settings.json` — not to
userData. Anything this fork does with agent hooks reaches the Orca they run
every day. This is why the gate is enforced through the repo's
`.claude/settings.json` (project-scoped, ours alone) rather than a PreToolUse
hook.
