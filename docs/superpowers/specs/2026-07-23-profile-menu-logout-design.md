# Profile Menu + Local Logout — Design

**Status:** approved (owner: title-bar right cluster; logout = local disconnect, keep work; build autonomous). Client-only — no sync-server change, no deploy.

**Goal:** A persistent account home. A profile icon in the title-bar right cluster opens a small menu: signed-out → sign in / setup code; signed-in → your company + Log out. Log out is a **local disconnect** that keeps all local work.

**Why:** Today every sign-in surface is contextual (sync dot, left-rail pill, first-run dialog). Once onboarding is dismissed there's no obvious account place, and there is **no logout at all** — you can't disconnect or start fresh.

## Behavior
- **Profile button** (`#profileBtn`) in the title-bar right cluster (near `#sync`/`#helpBtn`/`#themeBtn`), always visible. Click → a small menu (reuse the existing menu/popover idiom).
- The menu reads `GET /api/account` (`{state:"local"|"connected", companySlug?}`) and `GET /api/sync` (`signInAvailable`):
  - **Signed out (`state:"local"`):** "Sign in" (→ `startSignIn()` when `signInAvailable`, else the setup-code path) and "Have a setup code?" (→ `openConnectAccount()`).
  - **Signed in (`state:"connected"`):** show the company (`"Connected to <companySlug>"`) and **"Log out"**.
- **Log out** → a confirm ("Log out disconnects this device from **<company>**. Your work stays on this machine. If you signed in anonymously, you may not be able to get back in unless you've linked Google.") → `POST /api/logout` → on success refresh the sync surface (`refreshProjects`). The sync dot goes grey (local); the sign-in surfaces reappear.

## Local disconnect (the new capability)
`POST /api/logout` runs, for the active org, a `disconnect`:
1. **Remove the git `origin` remote** from each writable root (`SyncEngine.removeRemote(dir)` = `git remote remove origin`, guarded on `hasRemote`) — so `unsaved.connected` (= `remotes.some(Boolean)`) becomes false and the dot reverts to local. Local commits/history are untouched (invariant 8).
2. **Clear the account** (`AccountStore.clear()`): `keychain.delete` the machine + refresh token keys, delete `account.json` — so `accountState()` reports `local` and no stale creds remain.
No server call (no token revoke — that's an admin S2S path; operator self-revoke is a follow-up; the token simply goes unused and expires).

## Components
- `apps/client/src/sync/engine.ts`: `removeRemote(dir)`.
- `apps/client/src/account/account-store.ts`: `clear()`.
- `apps/client/src/account/disconnect.ts` (new): `disconnect({ engine, account, roots })` — removeRemote each writable root, then `account.clear()`; returns `{ state: "local" }`.
- `apps/client/src/daemon/daemon.ts`: `POST /api/logout` → `deps.logout()`; `DaemonDeps.logout?`. Never 500.
- `apps/client/src/wiring.ts`: build the `logout` dep (disconnect on the active org's writable roots).
- `apps/client/web/js/profile.js` (new): `function openProfile()` + the menu; `web/index.html` `#profileBtn`; `console-harness.ts` EXPOSE; CSS.

## Invariants / constraints
- **Never lose work (inv 8):** disconnect removes remotes + creds only; git history stays. Confirm copy says so.
- **Operator copy only:** no `push`/`commit`/`branch`/`merge`/`diff`/`token`/`JWT` in visible strings. "Sign in", "Log out", "your company", "your work stays on this machine".
- **Never 500:** `/api/logout` maps errors to 400, mirrors the other routes.
- Hermetic tests; the console menu jsdom-tested (visibility per state, logout confirm → POST → refresh, no banned vocab).

## Deferred (follow-ups)
- Server-side token revoke on logout (self-revoke endpoint).
- Detecting anonymous accounts to show the recovery warning precisely (v1 uses a generic honest line).
- Account switching (multiple identities) — out of scope; this is one profile per active org.
