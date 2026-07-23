# Profile Menu + Local Logout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** A persistent profile icon in the title-bar right cluster (sign in / your company / Log out), and a local **logout** that disconnects the active org (removes remotes + creds) while keeping all local work. Client-only; no sync-server change; no deploy.

**Architecture:** `disconnect` = remove each writable root's `origin` remote (`SyncEngine.removeRemote`) + clear the account (`AccountStore.clear`). Exposed as `POST /api/logout`. A console profile menu reads `/api/account` + `/api/sync` and routes to the existing sign-in / setup-code / logout actions.

## Global Constraints
- **Never lose work (inv 8):** disconnect removes only remotes + creds; git history stays.
- **Operator copy only:** never `push`/`commit`/`branch`/`merge`/`diff`/`token`/`JWT` in visible strings.
- **Never 500** on `/api/logout` (map errors to 400, like the other routes).
- Hermetic tests. Run ONLY targeted test files, foreground; NEVER a background/detached full-suite run or Monitor.
- Tests: `npm run test --workspace @buildex/client -- --run <files>`; typecheck `npm run typecheck --workspace @buildex/client`.

---

### Task 1: disconnect mechanics — `removeRemote`, `AccountStore.clear`, `disconnect`

**Files:** Modify `apps/client/src/sync/engine.ts`, `apps/client/src/account/account-store.ts`; Create `apps/client/src/account/disconnect.ts`. Tests: `engine.test.ts`, `account-store.test.ts`, `disconnect.test.ts`.

**Interfaces / Produces:**
- `SyncEngine.removeRemote(dir: string): Promise<void>` — `git remote remove origin`, but ONLY if `hasRemote(dir)` (no-op otherwise; never throws on a remote-less repo).
- `AccountStore.clear(): void` — `keychain.delete(machineTokenKey(orgId))`, `keychain.delete(refreshTokenKey(orgId))`, and delete the `account.json` file (best-effort: if it doesn't exist, no throw). After `clear()`, `load()` → null and `connected()` → false.
- `disconnect(deps: { engine: SyncEngine; account: AccountStore; roots: { name: string; dir: string }[] }): Promise<{ state: "local" }>` in `disconnect.ts` — for each root, `engine.removeRemote(dir)`; then `account.clear()`; return `{ state: "local" }`. (Remove remotes on ALL roots incl. core — a clean local revert.)

- [ ] **Step 1 (engine):** Read `addRemote`/`hasRemote` in engine.ts. Write a failing test: on a repo with an `origin` remote, `removeRemote` removes it (`hasRemote`→false) and keeps history (`git log` unchanged); on a repo with NO remote, `removeRemote` is a no-op (no throw). Implement `removeRemote`. Pass. (`--run src/sync/engine.test.ts`)
- [ ] **Step 2 (store):** Read `account-store.ts` (find how `account.json` path is derived + written). Write a failing test: after `save(...)`, `clear()` makes `load()`→null, `tokens()`→null, and the `account.json` file is gone; `clear()` on an already-clear store doesn't throw. Implement `clear()`. Pass. (`--run src/account/account-store.test.ts`)
- [ ] **Step 3 (disconnect):** Write `disconnect.test.ts` (real `file://` bares + temp roots, in-memory keychain, mirroring `open-account.test.ts` setup): after attaching roots (remotes present) + saving an account, `disconnect(...)` → `{state:"local"}`, every root has NO remote, `account.json` gone, keychain tokens gone, AND a seed commit still present in each root (work kept). Implement `disconnect.ts`. Pass. (`--run src/account/disconnect.test.ts`)
- [ ] **Step 4:** typecheck clean. Commit: `feat(account): local disconnect - removeRemote + AccountStore.clear + disconnect()`.

---

### Task 2: daemon `POST /api/logout` + wiring

**Files:** Modify `apps/client/src/daemon/daemon.ts`, `apps/client/src/wiring.ts`. Test: `daemon.test.ts`.

**Interfaces:**
- Consumes `disconnect` (Task 1).
- Produces: `DaemonDeps.logout?: () => Promise<{ state: "local" }>`. Route `POST /api/logout`: if `!deps.logout` → 404/`{error:"not found"}` (or the file's no-op convention — match how an unwired route behaves); else run it → `json({state:"local"})`; any throw → 400, NEVER 500 (mirror `/api/signin`/`/api/account` error mapping). `wiring.ts` builds `logout` = `() => disconnect({ engine: sync, account: acc, roots: config.roots })` for the active org — wired whenever an account store exists (i.e. not the sandbox; a sandbox org has no account to clear, but disconnect on a remote-less sandbox is a harmless no-op — still, gate `logout` the same way `openAccount`/`accountState` are gated so it only appears for a real org).

- [ ] **Step 1: Failing test** in `daemon.test.ts` (mirror `/api/account`): `logout` undefined → `POST /api/logout` returns the file's unwired-route response; a fake `logout` resolving `{state:"local"}` → 200 `{state:"local"}`; a throwing `logout` → 400 (never 500).
- [ ] **Step 2:** Run (`--run src/daemon/daemon.test.ts`) → FAIL. **Step 3:** Implement route + `DaemonDeps.logout` + wiring. **Step 4:** Run → PASS + typecheck. Commit: `feat(daemon): POST /api/logout - local disconnect of the active org`.

---

### Task 3: console profile menu

**Files:** Create `apps/client/web/js/profile.js`; Modify `apps/client/web/index.html` (add `#profileBtn`, register `js/profile.js`), `apps/client/src/console-harness.ts` (EXPOSE `openProfile` + any new top-level fn), a CSS file. Test: `apps/client/src/console-profile.test.ts` (jsdom).

**Interfaces:** Consumes `GET /api/account` (`{state, companySlug?}`), `GET /api/sync` (`signInAvailable`), `POST /api/logout`, and the existing `startSignIn()` / `openConnectAccount()` / `refreshProjects()` / `postJSON` / `getJSON` / `esc`.

**Notes:** `#profileBtn` goes in the title-bar right cluster (`web/index.html`, near `#sync`/`#helpBtn`/`#themeBtn` — read the cluster). Mirror the modal/menu idiom of `web/js/signin.js` / `web/js/account.js`. `postJSON` resolves with the body regardless of status — branch on `res.state`/`res.error` (like signin.js), not try/catch on rejection.

- [ ] **Step 1: Failing test** `console-profile.test.ts` (mirror `console-signin.test.ts`): (a) `openProfile()` with `/api/account`→`{state:"local"}` + `/api/sync`→`{signInAvailable:true}` shows a "Sign in" action and a "Have a setup code?" action, no company line, no "Log out". (b) with `/api/account`→`{state:"connected", companySlug:"acme"}` shows "acme" + a "Log out" action, and NOT the sign-in actions. (c) clicking "Log out" shows a confirm; confirming POSTs `/api/logout` and on `{state:"local"}` refreshes (`refreshProjects`). (d) no banned vocab in any rendered string; the logout confirm mentions "your work stays on this machine".
- [ ] **Step 2:** Run (`--run src/console-profile.test.ts`) → FAIL. **Step 3:** Implement `profile.js` (`function openProfile()`), the `#profileBtn` + click→`openProfile()`, the EXPOSE entries, CSS, and index.html script tag. Signed-out "Sign in" calls `startSignIn()` when `signInAvailable` else `openConnectAccount()`; "Have a setup code?" → `openConnectAccount()`; "Log out" → confirm → `POST /api/logout` → `refreshProjects()`. **Step 4:** Run `--run src/console-profile.test.ts src/console-signin.test.ts` (no regression) + typecheck. Commit: `feat(console): profile menu - sign in / your company / log out in the title bar`.

---

### Final: whole-branch review → `task ci` → merge → push (no deploy — client-only).
