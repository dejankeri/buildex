# Anonymous-First Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** One-screen cloud onboarding — type a company name, keep "back up to the cloud" (default) → Supabase anonymous sign-in → `POST /session {jwt, companyName}` → named company-of-one + machine token. Dormant until Supabase is configured.

**Architecture:** Reuses dormant Phase 3. Backend threads an optional `companyName` through `/session` → `provisionBySession` (new `slugFromName`). Client adds a `signInAnonymously` seam (no browser), a `signUpAnonymous` flow, a daemon `POST /api/onboard`, and a first-run dialog gated on `signInAvailable`.

**Tech Stack:** TypeScript NodeNext; `apps/sync` zero-dependency Node 22; Vitest; `apps/client` Electron; web console = classic-script JS (jsdom).

## Global Constraints
- **`apps/sync` zero npm dependencies** — `node:crypto`/injected `fetch` only. No new dep (STOP + escalate).
- **Dormant-safe:** no Supabase config → `/api/onboard` 501, first-run dialog is local-only, `/session`'s new `companyName` is an unused optional. Existing routes/boot byte-for-byte unchanged.
- **Machine token off disk** (keychain/`http.extraHeader` only) — unchanged; do NOT persist any Supabase session in this build (the deferred link feature owns that).
- **Sandbox org never attaches** — refuse before anything irreversible (before the anon sign-in call too).
- **Hermetic tests, DI seams.** Anonymous sign-in behind the `SupabaseAuthClient` seam; no real network in unit lanes.
- **Operator-copy only** — never `push`/`commit`/`branch`/`merge`/`diff`/`token`/`JWT` in any visible string.
- **`[release-gate:signin-jwt]` must stay green** — the verify path is unchanged; a forged/expired/wrong-issuer JWT still mints nothing.
- Tests: `npm run test --workspace @buildex/sync|client`. Gate: `task ci`. Run ONLY targeted files; NEVER launch a background/detached full-suite run or a Monitor (a prior agent wedged the machine doing that).

---

### Task 1: `companyName` through `/session` + `provisionBySession` + `slugFromName`

**Files:**
- Modify: `apps/sync/src/store/store.ts` (add `slugFromName`; factor shared slugify/dedup)
- Modify: `apps/sync/src/provisioning/service.ts` (`provisionBySession` gains `companyName?`)
- Modify: `apps/sync/src/http/app.ts` (`/session` body gains `companyName?`)
- Test: `apps/sync/src/store/store.test.ts`, `apps/sync/src/provisioning/service.test.ts`, `apps/sync/src/http/app.test.ts`

**Interfaces:**
- Produces: `store.slugFromName(name: string): string`; `provisionBySession({ sub, email?, companyName?, machineName })`.
- Consumes: existing `slugFromEmail` (share its slugify+dedup internals), `createCompany`, `mintMachine`, `withCloneUrls`.

- [ ] **Step 1 (store):** Read `slugFromEmail` in `store.ts`. Extract the slugify (lowercase, `[^a-z0-9]+`→`-`, trim `-`, empty→`"company"`) + collision-suffix (`-2`,`-3`,…) logic into a shared helper, and add `slugFromName(name)` that slugifies `name` through it. `slugFromEmail` keeps deriving the local-part then calling the shared slugify. **Failing test first:** `slugFromName("Acme Labs")` → `"acme-labs"`; after a company `acme-labs` exists → `"acme-labs-2"`; `slugFromName("")` / `slugFromName("***")` → `"company"`. Run (`--run src/store/store.test.ts`), implement, pass.
- [ ] **Step 2 (provisioning):** `provisionBySession` gains `companyName?`. In the create-new branch: `const slug = opts.companyName ? store.slugFromName(opts.companyName) : store.slugFromEmail(opts.email ?? "user")`, and `createCompany({ id, slug, name: opts.companyName ?? slug })` (display name = typed name when present). Keep the slug→create section await-free (TOCTOU). **Failing test:** `provisionBySession({sub:"a1", companyName:"Acme Labs", machineName:"m"})` → repos include `team-acme-labs`, and the stored company's display name is `"Acme Labs"` (assert via a store read); idempotent same-sub still returns the same company. Run (`--run src/provisioning/service.test.ts`), implement, pass.
- [ ] **Step 3 (route):** `/session` body type gains `companyName?: string`; pass `companyName: b.companyName` into `provisionBySession`. **Failing test** in `app.test.ts`: a wired `/session` with `{jwt, companyName:"Acme"}` returns 200 with `repos.team` ending `team-acme`; the dormant 501 / 401 / missing-jwt-when-wired behaviors are unchanged (companyName is optional). Run (`--run src/http/app.test.ts`), implement, pass.
- [ ] **Step 4:** `npm run test --workspace @buildex/sync` (full) + `npm run typecheck --workspace @buildex/sync` green. **Commit:** `feat(sync): /session accepts a company name (slugFromName) for anonymous onboarding`.

---

### Task 2: `signInAnonymously` seam + real GoTrue adapter

**Files:**
- Modify: `apps/client/src/account/sign-in.ts` (`SupabaseAuthClient` interface)
- Modify: `apps/client/src/account/real-seams.ts` (`realSupabaseAuthClient.signInAnonymously`)
- Test: `apps/client/src/account/real-seams.test.ts` if it exists, else cover the seam usage in Task 3's flow test (the real adapter is owner-verified at cutover, like the OAuth adapters).

**Interfaces:**
- Produces: `SupabaseAuthClient.signInAnonymously(): Promise<{ jwt: string }>`.

- [ ] **Step 1:** Add `signInAnonymously(): Promise<{ jwt: string }>` to the `SupabaseAuthClient` interface in `sign-in.ts` (alongside `authorizeUrl`/`exchangeCode`).
- [ ] **Step 2:** Implement it in `real-seams.ts` `realSupabaseAuthClient`: `POST <supabaseUrl>/auth/v1/signup` with headers `{ apikey: anonKey, "content-type": "application/json" }` and an empty-credential body (GoTrue anonymous sign-in — base on GoTrue's documented anonymous endpoint; add a comment that the exact body/endpoint is owner-verified at cutover, same as the OAuth adapters). Parse `access_token` from the response → return `{ jwt: access_token }`. Errors: a failed fetch / non-2xx / missing `access_token` → a typed `Error` with a clear message, no raw throw leaking (mirror `exchangeCode`'s error handling in the same file).
- [ ] **Step 3:** typecheck clean (`npm run typecheck --workspace @buildex/client`). If a `real-seams.test.ts` exists, add a fake-fetch test that `signInAnonymously` posts to `/auth/v1/signup` with the apikey and returns the `access_token`; otherwise rely on Task 3's hermetic flow test (note which in the report). **Commit:** `feat(account): SupabaseAuthClient.signInAnonymously - GoTrue anonymous sign-in seam`.

---

### Task 3: `signUpAnonymous` flow

**Files:**
- Create: `apps/client/src/account/anonymous.ts`
- Test: `apps/client/src/account/anonymous.test.ts`

**Interfaces:**
- Consumes: `SupabaseAuthClient.signInAnonymously` (Task 2); `postSession` (`session-client.ts`); `persistAndAttach` (`open-account.ts`, self-guards sandbox); `AccountStore`; `SyncEngine`.
- Produces: `async function signUpAnonymous(deps: { supabase: SupabaseAuthClient; account: AccountStore; engine: SyncEngine; roots: {name,dir}[]; sandbox: boolean; fetch: typeof fetch; baseUrl: string; machineName: string }, input: { companyName: string }): Promise<{ state: "connected" | "needs-help" }>`.

- [ ] **Step 1: Failing test.** All seams faked. `signUpAnonymous` with `sandbox:false`: `supabase.signInAnonymously()` returns `{jwt:"anon.jwt"}`; a fake `fetch` for `/session` (or a fake postSession path — use the real `postSession` against a fake fetch that returns a valid ProvisionResult) returns credentials; then `persistAndAttach` runs on real `file://` bares (mirror `open-account.test.ts`'s setup) → `{state:"connected"}`, account.json persisted, team ref pushed, `companyName` was sent in the `/session` body. Also: `sandbox:true` → throws `/sandbox/i` and `signInAnonymously` is NEVER called (guard first) and nothing persisted.
- [ ] **Step 2:** Run (`--run src/account/anonymous.test.ts`) → FAIL.
- [ ] **Step 3: Implement `anonymous.ts`.** Sandbox guard FIRST (`if (deps.sandbox) throw new Error("the sandbox org is local-only and cannot attach an account")` — copy the exact string used elsewhere). Then `const { jwt } = await deps.supabase.signInAnonymously()`; `const result = await postSession({ fetch: deps.fetch, baseUrl: deps.baseUrl }, { jwt, companyName: input.companyName, machineName: deps.machineName })`; `return persistAndAttach({ account: deps.account, engine: deps.engine, roots: deps.roots, sandbox: deps.sandbox }, deps.baseUrl, result)`. NOTE: `postSession`'s body must include `companyName` — if `postSession` (Task-9) doesn't forward it, extend its args to `{ jwt, companyName?, machineName }` and pass through (small change; keep provision/refresh untouched).
- [ ] **Step 4:** Run → PASS + typecheck. **Commit:** `feat(account): signUpAnonymous - anonymous sign-in → /session → attach`.

---

### Task 4: daemon `POST /api/onboard` + wiring

**Files:**
- Modify: `apps/client/src/daemon/daemon.ts` (route + `DaemonDeps`)
- Modify: `apps/client/src/wiring.ts` (build `onboard`, gated on Supabase config)
- Test: `apps/client/src/daemon/daemon.test.ts`

**Interfaces:**
- Consumes: `signUpAnonymous` (Task 3).
- Produces: `DaemonDeps.onboard?: (input: { companyName: string }) => Promise<{ state: "connected" | "needs-help" }>`.

- [ ] **Step 1: Failing test** in `daemon.test.ts` (mirror `/api/signin`): `onboard` undefined → `POST /api/onboard` → 501; a fake `onboard` resolving `{state:"connected"}` (reading the posted `companyName`) → 200 `{state:"connected"}`; a sandbox-message throw → 409; a generic throw → 400; never 500. Confirm the route reads `companyName` from the body (unlike `/api/signin`, which reads no body).
- [ ] **Step 2:** Run (`--run src/daemon/daemon.test.ts`) → FAIL.
- [ ] **Step 3:** Implement the route (read `{companyName}` via the daemon's `body()` helper; validate non-empty → else 400) + `DaemonDeps.onboard?`. In `wiring.ts`, build `onboard` ONLY when Supabase client config is present (same gate as `signIn`); it composes `signUpAnonymous` with `realSupabaseAuthClient(...)` + real `postSession` deps + `persistAndAttach`, sandbox refused first. When unwired → `onboard` undefined → `/api/onboard` 501 (dormant). A normal (no-config) boot must be unaffected.
- [ ] **Step 4:** Run daemon test + full client typecheck; confirm no-config boot unaffected. **Commit:** `feat(daemon): POST /api/onboard - anonymous company onboarding (501 when unconfigured)`.

---

### Task 5: First-run "name your company" dialog

**Files:**
- Create: `apps/client/web/js/onboard-dialog.js` (`function openOnboard()`)
- Modify: `apps/client/web/index.html` (register the script), `apps/client/src/console-harness.ts` (EXPOSE `openOnboard`), a CSS file for the dialog, and the first-run trigger (wherever `checkOnboarding()` / the wizard fires — grep `checkOnboarding`)
- Test: `apps/client/src/console-onboard.test.ts` (jsdom)

**Interfaces:** Consumes `GET /api/sync` (`signInAvailable`), `POST /api/onboard`, `postJSON`, `refreshProjects`, the modal `wz-*` styles.

- [ ] **Step 1: Failing test** `console-onboard.test.ts` (mirror `console-signin.test.ts` idioms): `openOnboard()` shows a modal with a **Company name** input and, when `signInAvailable:true`, two options — "Back up to the cloud" (default/checked) and "Keep everything on this device" — with the honest copy; when `signInAvailable:false`, the cloud option is absent (local-only). Submitting cloud with a name POSTs `/api/onboard {companyName}` and on `{state:"connected"}` tears down + calls `refreshProjects`. Submitting local proceeds without a POST. No banned vocab; the cloud copy says "Back up to the cloud" + a "link Google later" nudge line; local copy warns "you risk losing it".
- [ ] **Step 2:** Run (`--run src/console-onboard.test.ts`) → FAIL.
- [ ] **Step 3: Implement `onboard-dialog.js`** (`function openOnboard()`), the CSS, the index.html script tag, EXPOSE entry, and fire it on first run (adapt the existing `checkOnboarding` path — read it first; the dialog can be its own step or replace the wizard's first screen — keep it minimal and don't break the existing wizard tests). `postJSON` resolves with the body regardless of status (branch on `res.state`/`res.error`, mirror `signin.js`); on a dormant 501 show the friendly "not available yet" copy (the cloud option shouldn't even render when `signInAvailable:false`, so this is a fallback).
- [ ] **Step 4:** Run `--run src/console-onboard.test.ts src/console-signin.test.ts src/console-render.test.ts` (no regression) + typecheck. **Commit:** `feat(console): first-run dialog - name your company, back up to the cloud by default`.

---

### Task 6: Deploy dormant + verify + docs

**Files:** Optional note in `infra/infrastructure.md`.

- [ ] **Step 1:** After Tasks 1–5 merge to main and `task ci` is green, deploy: `task deploy --yes` (the image carries `/session`'s new `companyName`; dormant — no Supabase secrets).
- [ ] **Step 2: Verify dormant + no regression:** `/healthz` ok; `POST /session -d '{}'` → 501; `POST /api/onboard`… (client-side, not on the server — verify the sync-server side only: `/session` with `{jwt:"x", companyName:"y"}` still 501 dormant); re-run the live dogfood provision→team-push→core-reject to confirm existing flows unaffected.
- [ ] **Step 3:** Append the anon-onboarding note + the "enable anonymous sign-ins + abuse guard" cutover additions to `infra/infrastructure.md`; commit; merge/push.
