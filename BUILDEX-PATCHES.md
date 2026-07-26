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
.buildex-proofs/**
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
pnpm run lint                 # expect ONLY the Ghostty failure (see .buildex-proofs/UPSTREAM-BASELINE.md)
SKIP_BUILD=1 pnpm exec playwright test tests/e2e/buildex-surfaces.spec.ts \
  --config tests/playwright.config.ts --project=electron-headless --workers=1
```

Rebase **weekly**. At ~20 touch points of 1-3 lines each it is a 10-minute job;
let it slide a month and the renderer will have moved underneath you.

Drill result 2026-07-26: rebased 2 commits across 1 upstream commit — **clean, zero conflicts**.
