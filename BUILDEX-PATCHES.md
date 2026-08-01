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
src/renderer/src/components/sidebar/BuildExNavEntries.tsx
src/renderer/src/components/buildex-brain/*
src/renderer/src/components/buildex-store/*
src/renderer/src/components/buildex-portfolio/*
src/renderer/src/components/buildex-brand/*
tests/e2e/buildex-surfaces.spec.ts
config/scripts/verify-buildex-macos-release-env.mjs
config/scripts/verify-packaged-asar-contents.cjs
BUILDEX-PATCHES.md
```

There is no `buildex-apps/`. The Apps page was a viewer over packs BuildEx had
unpacked into the repo; once installing became the agent's own plugin CLI there
was nothing left for it to list that the Store did not already show.

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
| `src/main/window/createMainWindow.ts` | window title ×2 (the `BrowserWindow` title and the notification title) |
| `src/main/window/dashboard-popout-window.ts` | the third title site — the popout's own `BrowserWindow` title. Moves with the other two: they sit side by side in the OS Window menu, and reverting one alone reads "BuildEx" beside "Orca Agent Dashboard" |
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
| `src/renderer/src/components/buildex-brain/*`, `buildex-store/*`, `buildex-portfolio/*`, `buildex-brand/*` | **BuildEx-owned** surfaces. Upstream has no Brain, Store or Portfolio, so nothing here can conflict |
| `src/main/ipc/buildex-brain.ts`, `buildex-brain-placement.ts`, `buildex-store.ts`, `buildex-automation-context.ts`, `authorized-brain-location.ts` | **BuildEx-owned** IPC modules |
| `src/main/ipc/register-core-handlers.ts` | 4 imports + 4 registration calls |
| `src/preload/index.ts` | 5 type imports + 5 api namespaces (+2 type imports and 1 member for `buildexBrainSections.saveDiff`) |
| `src/preload/api-types.ts` | 5 type imports + 5 members on `PreloadApi` (+2 type imports and 1 member for `saveDiff`) |
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
call into a no-op. **And no other path reaches them either** — `createManagedWorktree`
returns through `createManagedRemoteWorktree` long before its `prepareCompanyWorktree`
call, and `initializeCompanyRepo` takes a path with no `connectionId`, so a BuildEx
surface cannot gate a remote checkout on the far side however hard it tries.
Nothing gates an SSH checkout from this machine. **That needs a writer on the far
side BuildEx does not have — a known gap, not an oversight.**

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

**A brain diff reuses Orca's diff renderer, not its diff parser.**
`BrainSaveDiff.tsx` renders through upstream's `NativeChatDiffView`, but the
lines are classified in `brain-save-diff.ts` and arrive over the wire already
typed as `NativeChatDiffLine`. Upstream's sibling parser, `diffFromText`, returns
`null` below two changed lines — a chat heuristic for "is this text even a diff",
and exactly wrong for a brain, where the commit that appends one bullet to
`rules/operating.md` is the common case. Nothing in `src/shared/native-chat-diff.ts`
or `NativeChatDiffView.tsx` is edited; both are imported as they are.

**`git show` is pinned, not left to config.** `show --format= -M --no-color
--no-ext-diff --no-textconv`, twice: once with `-z --name-status` for paths and
rename detection, once with `--patch` for the lines, paired by position. Every
flag predates Git 2.25. `-M` because `diff.renames=false` in an operator's config
would otherwise turn a rename into an add plus a delete; `--no-ext-diff` and
`--no-textconv` because a global diff driver would replace the patch with its own
output. The commit argument is checked against `/^[0-9a-f]{7,40}$/` before it is
passed, so no revision expression and no leading-dash option can reach git.

**The recency list's `git log` is pinned the same way, plus `-z`.** `log
--max-count=200 --format= --name-only -z -M --no-color --no-ext-diff
--no-textconv --no-show-signature -- <pathspec>`, every flag predating Git 2.25.
`-z` is the one addition and is not optional: `--name-only` octal-quotes any
non-ASCII path by default (`core.quotePath`), so a brain written in French would
produce ids that match nothing the scan just walked. No hash, no revision
expression and no user string reaches the command line — the only variable is the
location's own pathspec. Every failure path returns an empty list: a repo with no
commits, a folder workspace that is no repo, an SSH host without git. A brain
with no history is still a brain, and it must never cost a scan.

**An embedded brain belongs to the company, not to the branch.** `.buildex/` is
branch content, so a worktree left to itself read the snapshot its branch was cut
from and saved onto that branch — the brain fragmented the moment the operator
parallelised. Every checkout now converges on the **primary checkout's**
`.buildex/` through `embeddedBrainCheckout`, which is `worktree-primary-checkout.ts`
again — the same resolver the pointer, the binding and `resolveCompanyIdentity`
already use. A second identity mechanism would disagree with the first on the day
it matters. The location carries that path as its `gitRoot`, so **every** consumer
converges by construction rather than by remembering to: the scan, the save, the
history, the skill links, the removal and the migration all read it from there.
Three shapes and only three: a primary checkout keeps its own, a linked worktree
takes the primary's, and anything with no primary checkout — a folder workspace,
a worktree of a bare repo, a worktree whose main clone has moved off this machine
— keeps its own rather than being pointed at a guess.

**Convergence must not orphan the documents it is converging.** The population
upgrading into this rule is exactly "worktrees whose branch holds brain
documents", because every save from a worktree used to land there. Sent to a
brainless primary they would read as gone, `embeddedBrainPresent` would go false,
and the placement UI would offer *bind* ("nothing to move") over *migrate* — so
they could not even be moved out. So a checkout with a brain keeps it while the
primary has none, and converges the moment the primary has one. The test is
`isBrainInitialized`, never `existsSync('.buildex')`: the folder alone proves
only that BuildEx has run there, which is the same trap `gate-applied.json` and
`packs.json` each sprang once.

**Where a brain *lives* and where the decision about it is *recorded* are two
questions.** `embeddedBrainCheckout` answers the first, `brainPlacementCheckout`
the second, and the second is always the primary checkout — because the fallback
that finds a pointer or a binding reads worktree then primary and never the
reverse. A placement written into a worktree is visible from that worktree alone
while every sibling resolves elsewhere: the same split-brain, through a different
door. Both `migrateBrainToExternal` and `bindExistingBrain` write through the
placement checkout; only migrate's file moves and git commands use the other.

**Two checkouts, two commits.** Splitting those questions split migrate's writes
across checkouts, and a commit only reaches the one it runs in. The `git rm` is
staged where the brain was and committed there against `.buildex`; the pointer is
staged where the placement is recorded and needs its own commit against
`.buildex/brain.json`. They are the same checkout in every case but one — a
worktree holding a brain the primary never had, migrated with `writePointer` —
and there the single commit left the primary holding a staged `brain.json` for
the next unrelated commit to sweep up. Pathspec scoping defeated again, for an
addition instead of a deletion.

Two consequences worth knowing before touching any brain write path. First, an
embedded location can now name a path *outside* the repo the renderer asked
about, so `authorizeBrainLocation` authorizes that root — the one case; an
embedded brain in the very path asked about still needs nothing and widening it
would hand out access it never needed. Second, `checkout-commit-block.ts`, which
answers **why a checkout cannot take a brain commit** and covers two states that
fail in opposite directions:

- **Merge, rebase, cherry-pick, revert.** Git refuses the partial commit; the
  `git add` in front of it does not — so an unguarded write leaves the brain
  staged inside somebody's conflicted index and their merge commit sweeps it up.
  Pathspec scoping defeated through the back door.
- **Detached HEAD**, `git bisect` and a checked-out tag included. Git *accepts*
  the commit and nothing warns; it becomes unreachable as soon as a branch is
  checked out again. The operation is reported ahead of the detached HEAD a
  rebase also leaves, because resolving it brings the branch back.

It reads the checkout's own git dir (each has one, which is why it can answer per
checkout) and save, removal and **migration** all refuse before running anything.
Migration checks all three checkouts it may write to and does so **before the
backup**. Catching its own commit failure afterwards is precisely what leaves the
damage: mid-merge `git rm --ignore-unmatch` exits 0 and stages the deletion, the
partial commit exits 128 into a bare `catch`, and migrate would go on to delete
the files from disk and return `ok: true` — brain still in HEAD, its removal
staged in someone else's conflicted index.

**`.claude/skills/<name>` is relative only when the target is inside the
checkout.** It used to key that on `mode === 'embedded'` — true when embedded
meant "in this repo", and false since convergence. From a worktree the old test
wrote `../../../acme/.buildex/skills/x`: a link that escapes the checkout, is
rewritten on every worktree creation, and — if `.claude/skills/` is tracked —
enters history and resolves in a teammate's clone to whatever sits beside it.
Containment, not mode.

**A gate write is only ever as complete as the catalogue behind it.** The rules
must come from the shelf *that company* sees — `readCompanyStoreEntries(location)`,
bundled marketplaces plus the ones its own brain adds. Deriving them from another
company's catalogue omits every app from a marketplace that catalogue never had,
and `mergeList` then retires rules the app is still relying on. This is the same
trap as syncing with no plugin rules at all, through a different door; it bit
once via `initializeCompanyRepo` reading a repo-less catalogue, and once via the
Store fanning one company's rules out to all of them.

### Branding the visible copy — Phase 6, cut back by WP-7

**Branding is the interceptor and nothing else.** The app brands what the
*catalog* renders, plus the five identity surfaces below. Every other upstream
string — unlocalized literals, shared/runtime error messages, agent prompt text
— is left at upstream wording, because rewriting it delivered nothing to an
operator who already knows this is a fork of Orca and was the fork's single
largest rebase tax. WP-7 reverted ~110 upstream files' worth of it.

| File | Change |
|---|---|
| `src/shared/buildex-brand.ts` | **BuildEx-owned.** The rule, the protection list, `brandedTranslate` |
| `src/renderer/src/i18n/i18n.ts` | import + 1 line in `translate()` |
| `src/main/i18n/main-i18n.ts` | import + 1 line in `translateMain()` |
| `src/renderer/src/components/buildex-brand/BuildExWordmark.tsx` | **BuildEx-owned.** `BUILDEX` + "built on Orca" lockup |
| `src/renderer/src/components/Landing.tsx` | import + replaces the `ORCA` `<h1>` |
| `src/renderer/src/components/settings/BuildExAttributionSection.tsx`, `buildex-attribution-search.ts` | **BuildEx-owned.** Replaces upstream's "Support Orca" star prompt |
| `src/renderer/src/components/settings/GeneralPane.tsx` | 2 import lines + 1 render line |
| `src/main/window/createMainWindow.ts`, `dashboard-popout-window.ts` | window titles |
| `src/main/tray/system-tray.ts` | tray label |
| `src/shared/orca-attribution.ts`, `src/main/attribution/terminal-attribution.ts` | commit trailer + PR/issue footers, written into *other people's* repos |
| 39 upstream test files | expectations that read **catalog** output through the live interceptor. Not editable by hand: the interceptor brands them at runtime with no source diff to mirror |
| 7 more upstream test files | on the surface for **identity or structure**, not the catalog — release-feed URLs (`updater.test.ts`, `updater-prerelease-feed{,-readiness}.test.ts`, `UpdateCard.error-card.test.tsx`), the dev userData path (`configure-process.test.ts`), packaging (`electron-builder-config.test.mjs`), and one structural change with no brand string at all (`local-pty-provider.test.ts`) |

**No unlocalized literal is branded.** The 33 direct edits Phase 6 made
(`notification-settings-copy.ts`, `delete-worktree-dialog-copy.ts`,
`CrashReportDialogSurface.tsx`, terminal hints, …) are reverted. So are the
shared/runtime error strings (`remote-runtime-*`, `protocol-compat.ts`,
`runtime-environment-store.ts`, the web client) — those are plumbing, and
touching them broke the fork's own "plumbing untouched" rule.

**The dispatch preamble is upstream's again.** `orca-dispatch-status-prompt.ts`
and `orchestration/preamble.ts` both say "You are working inside Orca" because
the prefix is a **protocol handshake** between them, not display copy.

### Known artifacts of "brand only what the catalog renders"

Branding a chokepoint and nothing else means the seam is *inside the sentence*,
not at a module boundary. Two places in the UI show both names at once. Both are
the accepted cost of the rule, **not bugs** — do not "fix" them by rebranding the
literal, which is how the 110-file rebase tax was built the first time.

- **`ProjectViewWrapper.tsx`, the unsupported-view hover card.** The paragraph
  opens with the plain literal `unsupportedMessage` — "Orca doesn't support Board
  project views yet." — and continues with a `translate()` call the interceptor
  renders as "Switch to a Table view to work with this project in **BuildEx**."
  One `<p>`, two product names. The tab's `title` is a full catalog string, so
  hovering the tab and hovering the card give the same sentence under different
  brands.
- **The host-setup labels, in two panes.** `project-host-setup-options.ts` has
  `'Orca server version is incompatible'` and `'Update Orca on this host to set
  up projects'` as literals; the same two sentences exist as
  `auto.components.settings.RepositoryPane.hostSetupBlockedVersion` and
  `.hostSetupMissingCapability`, which render as BuildEx. Same label, two panes,
  two names.

The general shape: **a literal beside a catalog string in the same rendered
block.** If a third one turns up, add it here rather than editing the literal.

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

### Traps found while branding — and while reverting it

**Not every visible string is localized.** ~33 user-facing literals never reach
`translate()`, so the interceptor cannot see them (`notification-settings-copy.ts`,
`delete-worktree-dialog-copy.ts`, `CrashReportDialogSurface.tsx`, terminal
hints, …). Branding them means direct edits to upstream files — which is exactly
why WP-7 stopped. **Do not add them back.** If you ever need the list again:
every `Orca` string literal in source whose exact text is **absent** from
`en.json`.

**Do not rebrand a `translate()` fallback.** It is catalog-managed and its
value is dead text at runtime — and upstream's catalog has already *drifted*
from some fallbacks (`OnboardingFlow.ff92d15436` says "notify you know"; the
source says "notify you"). Editing one changes nothing and costs a rebase
conflict. The filter that distinguishes them is "is this exact string a value
in `en.json`".

**Some `Orca` literals are not copy at all.** `Orca Nerd Font Symbols` is a font
family; `pr-comments-resolution-prompt.ts` is agent prompt text, not UI;
`displayName: 'Orca'` in `RepositoryHostSetupsSection.test.tsx` is host fixture
data. A pattern sweep cannot see the difference.

**Every `Orca` literal in `src/main/**` and `src/shared/**` stays** — internal
errors, logs, IPC and remote-runtime messages. They are plumbing, not branding,
and editing them multiplies the rebase surface for no operator-visible gain.

**The dangerous class: code that string-matches its own copy.** Four places
keyed behaviour off the exact wording, so renaming the copy silently broke a
feature with no type error and no obvious test name. **All four are back to
upstream single-brand matching**, because the copy they match is upstream's
again — the dual-brand workaround only existed to survive the rebrand:

| File | What broke when the copy moved |
|---|---|
| `src/shared/remote-runtime-tailscale-hint.ts` | regex gate; the Tailscale remedy stopped being offered |
| `src/shared/remote-runtime-client-error-classification.ts` | recoverable-drop fragments; reconnects would reclassify as fatal |
| `src/shared/orca-dispatch-status-prompt.ts` | preamble prefix is a **protocol handshake** with `src/main/runtime/orchestration/preamble.ts`, not display copy |
| `src/renderer/src/lib/agent-row-primary-text.ts` | second dispatch detector; agent rows lost their task labels |

This is the standing argument against branding a runtime string at all: none of
these four failures has a type error or an obviously-named test behind it.

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

**A branded test expectation is one of two things, and only a test run can tell
them apart.** WP-7 classified all 88 modified test files by *trying* the revert:
restore the file to upstream, run it, and read the result.

- **Fails** ⇒ the expectation reads **catalog** output through the live
  interceptor. It must stay branded — there is no source edit to mirror. 46
  files.
- **Passes** ⇒ the expectation was a **free-standing fixture** (a host
  `displayName`, an error message the test constructs itself, a test name). Once
  the source says "Orca" again, a branded fixture is *stale* and stops
  exercising the real string. Revert it.

Two shapes hide inside "passes", and both were live in this repo. A negative
assertion goes vacuous in whichever direction is wrong:
`not.toContain('fork of an existing BuildEx agent session')` passed against
Orca-worded source while testing nothing, and `not.toContain('Explore Orca')`
does the same against a catalog string the interceptor renders as "Explore
BuildEx". Read every `not.` assertion by hand; the pass/fail rule alone cannot
see them. And `workspace-tab-agent-metadata.test.ts` fed a **BuildEx** dispatch
preamble to a detector that only knows the upstream prefix — green, and
detecting nothing.

**The snapshot is the rebase gate.** `src/renderer/src/i18n/buildex-brand-catalog.test.ts`
pins every branded catalog string. Upstream copy changes surface as one
reviewable diff instead of ~400 silent ones. Read it during each rebase.

### Surfaces — Phase 0.5

| File | Change |
|---|---|
| `src/shared/types.ts` | `'brain' \| 'store' \| 'portfolio'` on `TopLevelView`; `collapsedBrainSections` on `PersistedUIState`. `RightSidebarTab` is upstream's again — see below |
| `src/shared/top-level-view.ts` | `Record<TopLevelView, true>` entries |
| `src/renderer/src/store/slices/ui.ts` | 7 upstream `previousViewBefore*` unions gain each new view; `previousViewBeforeBrain/Store/Portfolio` (`Exclude<>`, ours) + 6 open/close actions |
| `src/renderer/src/hooks/resolve-zoom-target.ts` | `activeView` union |
| `src/renderer/src/lib/right-sidebar-visibility.ts` | 3 members on `RIGHT_SIDEBAR_SUPPRESSED_VIEWS`. **Not typechecked** — the set is `Set<ActiveView>`, so a view left out silently keeps the file explorer beside a full-screen surface |
| `src/renderer/src/components/sidebar/SidebarNav.tsx` | **3 lines**: import + `<BuildExNavEntries />` |
| `src/renderer/src/App.tsx` | 3 lazy imports + 3 render lines |
| `src/renderer/src/i18n/locales/{en,es,ja,ko,zh}.json` | the `buildex.*` keys. **Adding one is generated** — run `pnpm run sync:localization-catalog` and take whatever it writes. **Removing or rewording one is a hand-edit** (see below). Count deliberately not stated: it grows with every BuildEx surface and a number here only rots |

**The Brain is a top-level view, not a right-sidebar panel.** It started as one;
`BrainPanel.tsx`, the activity-bar item, the lazy import in
`right-sidebar-panel-content.tsx` and the `'brain'` entry in
`right-sidebar-route.ts`'s allowlist are all gone, and those three upstream files
are byte-identical to the merge-base again. The dead `| 'brain'` that survived on
`RightSidebarTab` is gone too (WP-4), so **`RightSidebarTab` carries no BuildEx
member at all** and that declaration is upstream's. Worth knowing on the next
rebase: upstream's plugin kernel adds `` | `plugin:${string}` `` to that same
union, and the drill saw it conflict at the exact line the Brain tab used to sit
on. There is nothing of ours there now — take upstream's side.

The `'brain'` that *is* still in `right-sidebar-visibility.ts` is a
`TopLevelView`, not a tab: it suppresses the file explorer beside the full-screen
surface. Do not remove it with the other one.

**The sync adds; it never prunes and never rewords.** `verify-localization-catalog.mjs --fix`
inserts keys the source references and repairs *parity* between `en.json` and the
other four — it has no step that removes a key nothing references any more, and
no step that notices a `translate()` fallback whose text changed. Both matter,
because **the catalog value is what renders and the fallback is dead text**:
change the fallback alone and the old string keeps appearing on screen with a
green typecheck, a green lint and a clean sync log.

So deleting UI is three steps, not one:

1. edit `en.json` by hand — delete the orphaned keys, rewrite any changed value;
2. make the same edit in `es`/`ja`/`ko`/`zh`, because every `buildex.*` value is
   English-seeded in all five and parity repair will not touch a value it
   already has;
3. **then** run `pnpm run sync:localization-catalog`, which drops the now-extra
   keys from the four non-English files and confirms parity.

WP-9 hit this: collapsing the Store's two shelves into one left
`buildex.store.shelf.otherShelfHint` ("check the other shelf's count") and
`shelf.empty` referenced by nothing, and changed `shelf.noMatches` from "Nothing
on this shelf matches" to "Nothing matches". The sync reported success and would
have shipped all three. WP-10 hit it again from the other side: dropping the
agent view's `notShown` and rewording `loadedHint` needed the same three steps,
and the reword is the half nothing checks — the old sentence renders from the
catalog with a green sync even after the fallback in the source has changed.
WP-11 hit it a third time: retiring the entity page and card orphaned five
`buildex.brain.entity.*` keys, and renaming the Add menu's "New entity" to
"New folder" was a delete of `sections.{newEntity,nameEntity}` by hand plus a
generated add of `sections.newFolder` — the delete half is the half the sync
cannot do.

**A fourth instance is still live at HEAD**, left as evidence of the reword half
rather than fixed blind. The Store's marketplace rework changed two fallbacks in
`StoreShelf.tsx` from "the indexes that ship with BuildEx could not be read …
reinstall the app" to "the marketplaces could not be reached … check the
connection", because indexes are fetched now and are not shipped. The **catalog
values were never rewritten**, so `buildex.store.shelf.catalogEmptyTitle` and
`.catalogEmptyHint` still render the old sentence and still tell the operator to
reinstall the app over what is a network failure. Seven `buildex.store.page.*`
keys ("Skill packs you install are written into your company repo") are orphaned
outright. Three steps, in the order above, and it does not matter that the source
already reads correctly — **the fallback is dead text**. `PROGRESS.md` records the
same defect for the operator-facing reader; **delete both entries in the same
commit that fixes the copy**, or the fork keeps claiming a live defect it no
longer has.

**The Portfolio is a composition, not a subsystem.** `buildex-portfolio/*` adds
no IPC and no main-process module: it enumerates the renderer's own `repos` and
calls `buildexBrain.resolve`/`scan`, `buildexStore.catalog` and
`automations.list`/`listRuns` once per business. `initializedCompanyRepos()` is
**not** the enumeration source — it is a per-run in-memory set of repos this
process has already touched, so on a fresh launch it is empty and the dashboard
would be blank until the operator visited each business one at a time, which is
the exact problem the page exists to remove.

**A dashboard must not write to the businesses it is summarising.**
`buildex-brain:scan` prepares the checkout on the way past — `initializeCompanyRepo`
(git exclude + the gate in `.claude/settings.json`), `relinkBrainSkills`, and a
void-fired `refreshCompanyContext`. Right for a repo somebody just opened; wrong
for N repos a table is reading, and it would repeat on every refresh. Both
`BrainScanRequest` and `StoreCatalogRequest` therefore carry **`readOnly?: boolean`**,
and the two handlers skip exactly those calls when it is set. A flag on an
existing handler, not a new module: the reading is identical either way, so the
two paths cannot drift on what a scan reports. `buildex-brain-read-only-scan.test.ts`
asserts both directions against a real repo.

Two things follow from the same rule. The sweep **probes before it scans**
(`resolve`, then `fs.readDir` of the brain root — both side-effect free), so a
repo that is not a business is never read at all. And a missing directory means
"not a business", while **any other error means BuildEx could not look**, which
renders as a degraded row rather than dropping the business.

**Nothing may wait on a host that never answers.** Probes are bounded
(`PROBE_DEADLINE_MS`) and reads are bounded (`COMPANY_DEADLINE_MS`); rows publish
as each probe lands and each business's read is queued behind the previous one,
so a blackholed SSH connection — which hangs until TCP gives up rather than
failing fast — costs its own row and never the screen.

**A row the operator cannot open is not a link.** `App.tsx` hydrates worktrees
only for the persisted session, so on a fresh launch every company the operator
has *not* opened has no workspace — and those are exactly the rows this page
exists to reach. The sweep calls the store's own `fetchWorktrees(repo.id)` for
any listed business without one, degraded rows included.

**SSH repos are probed over their connection, never resolved locally.**
`resolveBrainLocation` stats the local filesystem, so asking it about
`/home/ubuntu/acme` answers about a local directory that merely shares the path.
A remote business is listed and marked as readable only where it lives.

**No divergence column.** The brief asked for a diverged flag on external
brains; there is no read-only way to compute one from existing IPC.
`buildexBrain.pull` fetches and fast-forwards (a mutation, fanned out over N
companies), and `git:status` throws `Access denied` for any path that is not a
registered worktree or repo root — which an external brain repo never is. The
column reports **where the brain lives and whether this machine has it** instead
(`In repo` / `Own repo` / `Shared` / `Not cloned here` / `Brain missing` /
`Not a git repo`), which is true without a network call. Adding divergence needs
a read-only ahead/behind IPC; that is a deliberate gap, not an oversight.

---

## Traps found the hard way

**1. Typecheck does not find every registration site.**
`normalizeRightSidebarRoute()` validates the tab against a *runtime string
allowlist* and silently rewrites unknown values to `'explorer'`. The Brain tab
compiled, rendered its button, and quietly did nothing when clicked. Only an
end-to-end launch caught it. The Brain has since moved to a top-level view, but
the allowlist is still there and still unreachable from the type system.
**After adding a surface, always run `tests/e2e/buildex-surfaces.spec.ts`.**

**2. `previousViewBefore*` are hand-duplicated unions, not `Exclude<>`.**
Copies of `TopLevelView` minus one member. Every new BuildEx view costs one edit
per upstream copy — 7 as of the Portfolio. (BuildEx's own three are written as
`Exclude<>` and cost nothing.) *Candidate refactor:* rewrite them as `Exclude<TopLevelView, 'x'>` to make
future views free — deferred because it rewrites upstream declarations, and the
conflict cost of that rewrite may exceed the 8 edits it saves.

**3. Never lead the right sidebar's activity bar.**
`resolveRightSidebarEffectiveTab` falls back to `visibleItems[0]`, so a BuildEx
item placed first displaces Explorer as the default and degrades the developer
workflow this fork intends to keep. (Cost the Brain its sidebar slot; it is a
top-level view now, and the rule stands for whatever goes there next.)

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

**5. i18n is nearly free in one direction only.** `pnpm run sync:localization-catalog`
generates every *new* key across all five locales — run it before `pnpm lint`.
It does not prune a key nothing references any more, and it does not rewrite a
value whose copy changed, so **removing or rewording UI copy is a hand-edit
across all five files first.** See the locales row under Phase 0.5.

---

## Rebase procedure

```bash
git fetch upstream
git rebase upstream/main
pnpm install                  # lockfile may have moved
pnpm run typecheck            # must exit 0
pnpm run sync:localization-catalog
pnpm run lint                 # expect ONLY the pre-existing upstream Ghostty localization failure
pnpm exec electron-vite build --mode e2e          # REQUIRED — see below
SKIP_BUILD=1 pnpm exec playwright test tests/e2e/buildex-surfaces.spec.ts \
  --config tests/playwright.config.ts --project=electron-headless --workers=1
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/i18n/buildex-brand-catalog.test.ts   # read the snapshot diff
```

**Never run `SKIP_BUILD=1` against an `out/` tree you did not just produce.**
`tests/e2e/global-setup.ts` skips the build whenever `SKIP_BUILD` is set and
`out/main/index.js` exists, so the suite runs a **stale bundle**: a main-process
change is silently not under test and the run passes green against code you did
not write. The other half is `--mode e2e` — the specs read Zustand state through
`window.__store`, which only a preload bundle built in that mode exposes, so
reusing a plain `pnpm build` tree makes every spec hang on
`waitForFunction(() => Boolean(window.__store))` and time out at 30 s. Build
first, then `SKIP_BUILD=1` is safe and fast; or drop `SKIP_BUILD` entirely and
let global-setup build.

Rebase **weekly**. Let it slide a month and the renderer will have moved
underneath you.

**Current surface: 102 modified upstream files** (`git diff --name-only
--diff-filter=M $(git merge-base HEAD upstream/main) HEAD | wc -l`), down from
213 before WP-7 reverted the visible-copy rebrand. 56 carry structural or
identity diffs; the other 46 are **test files whose expectations read branded
catalog output through the interceptor**. Those 46 are a *floor*, not a backlog:
they have no source diff to mirror, so they cannot be unbranded without dropping
`brandedTranslate` itself. Any target below ~56 files is arithmetically
unreachable while the interceptor lives.

**Two audit predictions were arithmetically wrong; do not re-derive from them.**

- The audit set a **~55-file** post-revert target. 46 of the surviving 102 are the
  interceptor floor, so ~55 was never reachable — reaching it means deleting
  `brandedTranslate`, which is a product decision, not a tidy-up. The honest floor
  is 46 + whatever identity and registration genuinely require.
- WP-9's criterion predicted **~700–800 renderer LOC removed** from the Store.
  `src/renderer/src/components/buildex-store/` is **2 236 lines in total**,
  1 923 of them outside tests; the prediction was a ~40 % cut of a directory that
  had not been measured. WP-9 removed a shelf, a segment mechanism and a source
  parser, which is the right work — the number attached to it was invented.

If a future plan quotes a line or file count for this fork, measure it first. The
commands are one line each and both are in this file.

### Drill, 2026-08-01 — the first one against a real gap

The previous note here read "rebased 2 commits across 1 upstream commit — clean,
zero conflicts", and README extrapolated a **ten-minute job** from it. Both were
measuring a days-old gap and 2 commits. Measured properly:

| | |
|---|---|
| Gap | **388 upstream commits over 5.2 days** — merge-base `a1a78da878` (2026-07-26) to `16c5526dfd` (2026-08-01) |
| Replayed | **99 fork commits** |
| Upstream rate | **1 795 commits in the preceding 4 weeks** (~450/week), so "weekly" means a ~450-commit gap |
| **Conflict stops** | **19** |
| **Distinct conflicted files** | **26** (38 file-conflict events — one file conflicts repeatedly as the replay walks past it; `electron-builder.config.cjs` stopped the rebase 5 times) |
| Needing real judgment | **5 stops**, across 4 distinct files |
| Machine time | **9.2 s** — the clock is not the cost; the 19 decision points are |

**Quote the stop count, not the file count.** A rebase stops once per *commit*
that conflicts, so one hot file bills once per fork commit that touches it.

**The conflicts that need a human.** These five stops are where the fork's line
and upstream's line are not two insertions at one anchor — one side is gone, or
both rewrote the same value.

| File | Why it is semantic |
|---|---|
| `UpdateCard.tsx` | Upstream moved release-URL construction into a new `src/shared/release-channel.ts` (channel-aware: `stablyai/orca` vs `orca-hourly`). The fork's local `releaseUrlForVersion` has **no upstream anchor left** — it must be re-expressed against the new module, not merged |
| `package.json` `scripts.build:mac{,:release}` | Upstream added `config/scripts/build-mac-local.mjs` and its own verify step *inside the same lines* the fork rewrote. Correct resolution keeps upstream's new step **and** the BuildEx verifier |
| `package.json` identity block | `name`/`version`/`description`/`homepage`/`author` — always ours, every rebase, forever. Cheap but unavoidable |
| `right-sidebar-panel-content.tsx` | One side of the hunk is **empty**: the fork adds the Brain lazy-import, a later fork commit removes it again, and upstream moved the surrounding lines in between. Nothing to merge — take upstream's |
| `SkillFreshnessUpdateDialog.test.tsx` | An interceptor-floor test whose upstream expectations moved underneath the branded ones |

**The other 22 files were trivially mechanical** — an adjacent-line insertion on
both sides of one anchor, resolvable without reading either project's intent:
`.gitignore`, `README.md`, `config/electron-builder.config.cjs`,
`config/scripts/run-electron-vite-dev.mjs`, `src/main/updater.ts`,
`src/main/updater-prerelease-feed-readiness.test.ts`,
`src/main/runtime/orca-runtime.ts`, `src/main/ipc/buildex-brain.ts`,
`src/main/ipc/buildex-brain-placement.ts`, `src/preload/index.ts`,
`src/preload/api-types.ts`, `src/shared/types.ts`, `src/shared/feature-tips.ts`,
`src/shared/remote-runtime-client.ts`,
`src/renderer/src/components/settings/browser-search.ts`,
`src/renderer/src/components/tab-group/AiVaultSessionDropLayer.tsx`,
`src/renderer/src/hooks/useAutomationDispatchEvents.test.ts`, and the five
`src/renderer/src/i18n/locales/*.json`.

**The locales are mechanical only as JSON.** Both sides append at the same
end-of-object anchor, so a *textual* "keep both" produces invalid JSON — the
brace depths differ. Merge them as data, or take upstream's file and re-run
`pnpm run sync:localization-catalog`.

**The registration-only rule holds where it is followed.** `pty.ts`,
`register-core-handlers.ts` and `App.tsx` — the dual-touched files this drill
existed to stress — **did not conflict once** across 388 upstream commits.
`preload/index.ts` and `api-types.ts` conflicted once each, mechanically. The
files that hurt are the ones carrying *logic* the fork rewrote: build config,
release URLs, `package.json`.

**Replaying history costs more than reconciling trees.** A single 3-way merge of
the same two tips conflicts in **19 files with no repetition**:

```bash
git merge-tree --write-tree HEAD upstream/main   # read-only; lists conflicts
```

Under `rebase`, five files conflict *twice* because the branch replays the Phase
6 rebrand **and then WP-7's revert of it** — work whose net diff at HEAD is zero.
Before the next rebase, consider whether the branch's history is worth replaying
at all.

**Seven of the 26 conflicted files carry no net fork diff at HEAD** —
`feature-tips.ts`, `remote-runtime-client.ts`, `browser-search.ts`,
`AiVaultSessionDropLayer.tsx`, `right-sidebar-panel-content.tsx`,
`buildex-brain{,-placement}.ts`. They are pure replay artifacts, and **five of
them ended the drill worse than they started**: the obvious "keep both sides"
resolution re-introduced reverted rebrand copy and grew the surface from 102 to
**107**. `feature-tips.ts` came out with a duplicate `title`/`description` pair —
valid TypeScript, dead keys, no error anywhere. `right-sidebar-panel-content.tsx`
came out importing `./BrainPanel`, a file that no longer exists.

**A rebase that finishes is not a rebase that is correct.** Git's exit code says
nothing; the gates above are the check. Two cheap post-rebase assertions worth
running before the suite: the modified-file count should not have *grown*, and
`git diff --diff-filter=M` should not list a file that WP-7 reverted.

> **The 102 → 107 tree no longer exists.** The drill ran on a scratch branch that
> was deleted on completion, by design — nothing from a measurement should be
> landable. So the duplicate keys and the dangling `BrainPanel` import are
> *observed and discarded*, not preserved evidence: they cannot be inspected from
> this repo and are not reproducible from the commit history. To see them again,
> re-run the drill. The reproducible half is the read-only `merge-tree` command
> above, which needs no scratch branch and confirms the 19-file figure on demand.

**Why the command above is still `git rebase`.** The merge-vs-rebase numbers are
recorded here because a future session should have them — not because the
procedure changed. Switching a long-lived fork from rebase to merge is a workflow
decision with its own blast radius: it changes what `upstream/main` means in this
branch's history, what a reviewer reads in a diff, and how the release line is
cut. That is a call to make deliberately, with the release process in view, and
not a side effect of a measurement task. **Take the data, not a conclusion**; if
someone does make the switch, this section is the evidence for it, and the drill
should be re-run afterwards because these conflict counts are specific to
replaying 99 commits.

## Fork exit criteria

The fork is the substrate because nothing else can hold the two load-bearing
pieces: **PTY env injection at spawn** (`pty.ts`, `applyCompanyPluginEnv` inside
`buildPtyHostEnv`) and **per-repo gate sync at activation and worktree
creation**. Both run *before* an agent starts, inside the main process, with the
checkout's absolute path in hand. A Claude Code skill runs after that, in the
agent, with none of it.

That is a statement about today's substrate, not a permanent one. The trigger to
re-evaluate is **upstream's plugin kernel reaching parity with what Brain and
Store actually need**.

### Where the kernel stands

Upstream landed it in `97e4776dfe` (2026-07-27) — kernel, content packs,
sandboxed iframe panels, forked worker hosts, marketplace v0, behind a settings
flag, with `examples/plugins/hello-orca` and `examples/plugins/hostile-panel`.
It is **ahead of this fork's merge-base and not in HEAD's history**; the first
rebase past 2026-07-27 brings it in. Its first visible effect is already in the
drill: `src/shared/types.ts` conflicts because upstream added
`` | `plugin:${string}` `` to `RightSidebarTab` at the exact line the Brain tab
is registered on.

### What Brain and Store would need from it

Read against `plugin-capabilities.ts`, `plugin-events.ts` and
`plugin-host-api.ts` at `upstream/main`. v0 grants a closed set —
`workspace:read`, `terminal:send`, `notifications:show`, `storage`, `secrets`,
`events:subscribe`, `settings:own` — and a host API of `workspace.*`,
`terminal.send`, `notifications.show`, `storage.*`, `secrets.*`, `settings.*`,
`events.subscribe`. Evaluate the gap against these five, in order of how hard
they are to fake:

1. **A hook that runs before the agent does.** The gate and the env have to land
   between "a checkout is chosen" and "the process spawns". v0 has three events
   — `worktree.created`, `worktree.removed`, `agent.status.changed` — all
   fire-and-forget notifications after the fact, and none at spawn. **Parity
   means an awaited pre-spawn hook that can contribute environment**, not an
   event that arrives afterwards.
2. **Filesystem write into the operator's checkout.** The gate is
   `.claude/settings.json` *in the repo*; the brain is `.buildex/` in the repo.
   `workspace:read` is scoped to "name, branch, and terminal list" and
   `storage`/`secrets` are the plugin's own private folders. There is no
   `fs:write`, scoped or otherwise.
3. **Running git.** Context refresh, brain history, save diffs and convergence
   are all `git` invocations against arbitrary checkouts. `process:exec` is
   documented as deferred to a later phase.
4. **Full-window views, not sidebar panels.** Brain, Store and Portfolio are
   `TopLevelView`s. `contributes.panels` are sandboxed iframes in the right
   sidebar. Parity needs either a top-level surface contribution or an honest
   decision to live in the sidebar.
5. **SSH-host reach.** BuildEx already fails closed on remote checkouts (see
   "Remote worktrees are not gated on activation"). A plugin API that only ever
   runs on the desktop machine does not make that worse — but it does not fix it
   either, so it is not a reason to move.

(1) through (3) are the real gate. When a released Orca grants a pre-spawn hook
plus scoped filesystem and process capabilities, prototype the Brain against
`examples/plugins/hello-orca` before assuming it fits — the panel sandbox and the
worker host are separate trust boundaries and the Brain needs both.

### Why the decision stays reversible

Everything load-bearing is already in BuildEx-owned files and transfers
**byte-for-byte** to a plugin: `buildex-repo-init.ts`, `buildex-worktree-init.ts`,
`buildex-company-identity.ts`, the gate writer, the credential store, the brain
and store domain layers. The fork's *own* share is registration lines — 1-3 lines
per upstream file — and the drill shows those cost almost nothing (`pty.ts`,
`register-core-handlers.ts` and `App.tsx` survived 388 upstream commits without
one conflict).

So the exit is not a rewrite; it is deleting registrations and adding a manifest.
That asymmetry is exactly why shrinking the surface now is low-risk and why
waiting for the kernel to leave experimental is the cheaper bet than moving
early.

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

It bit a **third** time, in the one caller with no test file: `buildex-gate:sync`
synced bare, and the Store page fires that channel from an effect on every mount
and every workspace switch — so opening the Store retired every installed
plugin's rules. There are exactly three callers (`buildex-repo-init.ts`,
`buildex-store.ts`, `ipc/buildex-gate.ts`); `installedPluginGateRules` is
exported from `buildex-repo-init.ts` so none of them has to re-derive it. Grep
for `syncGateSettings(` before adding a fourth.

**Hook state is global and shared with the operator's real Orca.** Managed hooks
install to `~/.orca/agent-hooks/` and `~/.claude/settings.json` — not to
userData. Anything this fork does with agent hooks reaches the Orca they run
every day. This is why the gate is enforced through the repo's
`.claude/settings.json` (project-scoped, ours alone) rather than a PreToolUse
hook.
