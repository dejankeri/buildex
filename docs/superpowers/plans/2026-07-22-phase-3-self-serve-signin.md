# Self-Serve Sign-In & Sync (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator click "Sign in" (Supabase) instead of pasting a minted setup code — a front door that verifies a Supabase JWT and maps it to a find-or-create company-of-one, minting the same machine token `/provision` already mints.

**Architecture:** Supabase authenticates the human → JWT. A new `POST /session` on the sync service verifies that JWT (`node:crypto` only) and calls a new `provisionBySession` that finds-or-creates the user's company-of-one and mints credentials via the existing `mintMachine`. The client obtains the JWT via a system-browser PKCE + loopback flow, posts it to `/session`, stores the machine token, and runs the existing `attachOrg`. Ships dormant (`501`) until Supabase config is set.

**Tech Stack:** TypeScript NodeNext; `apps/sync` = zero-npm-dependency Node 22 (JWT verify via `node:crypto`); Vitest; `apps/client` Electron; web console = classic-script browser JS (jsdom-tested).

## Global Constraints

- **`apps/sync` has ZERO npm dependencies.** JWT verification uses `node:crypto` ONLY (`crypto.createPublicKey({ key, format: "jwk" })` + `crypto.verify`, RS256 + ES256). JWKS fetch uses the injected `fetch`. Adding any dependency = STOP and escalate.
- **Identity from JWT only (inv 7):** loopback redirect validated; OAuth `state` one-time + short TTL.
- **Machine token never on disk / in a URL / in argv / in a commit** — only `GIT_CONFIG_*` `http.extraHeader`. `[release-gate:no-token-on-disk]` must stay green.
- **Never lose an operator's work (inv 8):** sign-in ends in `attachOrg` (attach-in-place, first-publish); never discards local work.
- **Dormant-safe:** no Supabase config → `POST /session` returns `501 {"error":"sign-in not configured"}`; every existing route byte-for-byte unchanged.
- **Hermetic tests only** (no network in unit lanes). JWT/JWKS/OAuth/loopback all behind injected seams; `apps/sync` tests sign JWTs with a locally-generated keypair.
- **Operator-facing copy only:** never `push`/`commit`/`branch`/`merge`/`diff`/`token`/`JWT` in any visible string. Use "Sign in", "back up & sync", "your company".
- **Fixed loopback port:** `54121` for the OAuth callback (`http://127.0.0.1:54121/auth/callback`), with a free-port note in Task 8.
- Run `apps/sync` tests: `npm run test --workspace @buildex/sync`. Client: `npm run test --workspace @buildex/client`. Gate: `task ci`.

---

### Task 1: JWT verification over `node:crypto` (hermetic)

**Files:**
- Create: `apps/sync/src/auth/jwt-verify.ts`
- Test: `apps/sync/src/auth/jwt-verify.test.ts`

**Interfaces:**
- Produces:
  - `interface JwtClaims { sub: string; email?: string; iss: string; aud: string | string[]; exp: number; nbf?: number; iat?: number }`
  - `class JwtError extends Error { constructor(reason: string) }`
  - `interface JwkResolver { resolve(kid: string): Promise<JsonWebKey> }`
  - `interface VerifyConfig { issuer: string; audience: string }`
  - `function verifyJwt(token: string, deps: { keys: JwkResolver; now: () => number; config: VerifyConfig }): Promise<JwtClaims>`
- Consumes: nothing (leaf).

**Notes for the implementer:** A JWT is `base64url(header).base64url(payload).base64url(signature)`. Header has `alg` (`RS256`|`ES256`) and `kid`. Verify the signature over the ASCII bytes of `header.payload` using the JWK for `kid`. Node: `crypto.createPublicKey({ key: jwk, format: "jwk" })`, then for RS256 `crypto.verify("RSA-SHA256", data, keyObject, sig)`; for ES256 `crypto.verify("SHA256", data, { key: keyObject, dsaEncoding: "ieee-p1363" }, sig)` (ES256 JWT sigs are raw r||s, i.e. ieee-p1363). Reject any `alg` other than RS256/ES256 (never `none`). After signature: check `iss === config.issuer`, `config.audience` is in `aud` (string or array), `exp * 1000 > now()`, and if `nbf` present `nbf * 1000 <= now()`. Every failure throws `JwtError` with a distinct reason; success returns the parsed claims. Base64url decode: `Buffer.from(s, "base64url")`.

- [ ] **Step 1: Write the failing test.** In `jwt-verify.test.ts`, add a helper that generates an RSA keypair (`crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })`), exports the public key as JWK (`publicKey.export({ format: "jwk" })`) with a `kid`, and signs a JWT (build header `{alg:"RS256",typ:"JWT",kid}` + payload, base64url them, `crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey)`, base64url the sig). A `keys` resolver returns that JWK. Tests: (a) a valid token → returns claims with the right `sub`; (b) tampered payload → `JwtError`; (c) wrong `iss` → `JwtError`; (d) `aud` mismatch → `JwtError`; (e) `exp` in the past (via a fixed `now`) → `JwtError`; (f) `alg:"none"` header → `JwtError`.

- [ ] **Step 2: Run — expect FAIL** (`verifyJwt` not defined).
Run: `npm run test --workspace @buildex/sync -- --run src/auth/jwt-verify.test.ts`

- [ ] **Step 3: Implement `jwt-verify.ts`** per the notes above (RS256 + ES256; reject others; iss/aud/exp/nbf checks; `JwtError` on every failure).

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Typecheck + commit.**
Run: `npm run typecheck --workspace @buildex/sync`
```bash
git add apps/sync/src/auth/jwt-verify.ts apps/sync/src/auth/jwt-verify.test.ts
git commit -m "feat(sync): verify a Supabase JWT with node:crypto only (RS256/ES256, iss/aud/exp)"
```

---

### Task 2: JWKS cache (fetch + rotate)

**Files:**
- Create: `apps/sync/src/auth/jwks-cache.ts`
- Test: `apps/sync/src/auth/jwks-cache.test.ts`

**Interfaces:**
- Consumes: `JwkResolver` from Task 1.
- Produces: `function makeJwksCache(deps: { url: string; fetch: typeof fetch; now: () => number; ttlMs?: number }): JwkResolver` — fetches `{ keys: JsonWebKey[] }` from `url`, caches by `kid`, serves from cache within `ttlMs` (default 600000). On `resolve(kid)` miss, refetch ONCE (key rotation); still missing → throw `JwtError("unknown key id")`.

- [ ] **Step 1: Write the failing test.** A fake `fetch` returns a JWKS with kid `k1`, counting calls. Assert: first `resolve("k1")` fetches; second `resolve("k1")` within TTL does NOT refetch; `resolve("k2")` (unknown) triggers exactly one refetch and, if the second JWKS includes `k2`, returns it; a still-unknown kid throws `JwtError`; after `ttlMs` elapses (advance the fake `now`) a `resolve` refetches.

- [ ] **Step 2: Run — expect FAIL.**
Run: `npm run test --workspace @buildex/sync -- --run src/auth/jwks-cache.test.ts`

- [ ] **Step 3: Implement `jwks-cache.ts`.** Keep a `Map<kid, JsonWebKey>` + `fetchedAt`. Single-flight: store the in-flight promise so concurrent `resolve`s share one fetch.

- [ ] **Step 4: Run — expect PASS.** **Step 5: typecheck + commit** (`feat(sync): cache the Supabase JWKS with TTL + single refetch on key rotation`).

---

### Task 3: Supabase config (dormant-safe)

**Files:**
- Modify: `apps/sync/src/config.ts`
- Test: `apps/sync/src/config.test.ts`

**Interfaces:**
- Produces: `SyncConfig` gains `signIn?: { jwksUrl: string; issuer: string; audience: string }`. Present ONLY when all three of `BUILDEX_SUPABASE_JWKS_URL`, `BUILDEX_SUPABASE_ISSUER`, `BUILDEX_SUPABASE_AUDIENCE` are set (trimmed non-empty); otherwise `signIn` is `undefined`. Reuse the existing `trimOrUndefined`. Do NOT touch the existing required-key logic.

- [ ] **Step 1: Write the failing test.** In `config.test.ts`: with none of the three set → `readConfig(...).signIn` is `undefined`; with all three set → `signIn` equals `{ jwksUrl, issuer, audience }`; with only two set → `undefined` (all-or-nothing, no partial config). Keep an existing-behavior assertion that a valid base config still parses.

- [ ] **Step 2: Run — expect FAIL.** `npm run test --workspace @buildex/sync -- --run src/config.test.ts`
- [ ] **Step 3: Implement** the `signIn` block in `readConfig`. **Step 4: PASS.** **Step 5: typecheck + commit** (`feat(sync): optional Supabase sign-in config (all-or-nothing, dormant when unset)`).

---

### Task 4: Store — `supabase_sub` mapping + find-or-create company-of-one

**Files:**
- Modify: `apps/sync/src/store/store.ts` (migration + methods)
- Test: `apps/sync/src/store/store.test.ts`

**Interfaces:**
- Consumes: existing `createCompany({id, slug, name, mirrorRemotes?})`, `createOperator({id, companyId, email})` (confirm exact signatures in the file first; adapt if they differ).
- Produces on `ControlPlaneStore`:
  - a schema migration adding column `supabase_sub TEXT UNIQUE` to the operators table (additive; existing rows get NULL).
  - `findOperatorBySupabaseSub(sub: string): { operatorId: string; companyId: string } | null`
  - `linkOperatorSupabaseSub(operatorId: string, sub: string): void`
  - `slugFromEmail(email: string): string` helper — local-part, lowercased, non-alphanumerics → `-`, collapsed; if that slug's company exists, suffix `-2`, `-3`, … until free (use an existing "does company slug exist" read or add one).

**Notes:** follow the existing migration pattern in `store.ts` (find how the schema is created/versioned and add the column the same way — `ALTER TABLE ... ADD COLUMN` guarded so re-run is safe). Read the file before writing.

- [ ] **Step 1: Write the failing test.** Against a fresh in-memory/temp store: `findOperatorBySupabaseSub("s1")` → null; create a company + operator, `linkOperatorSupabaseSub(op, "s1")`; now `findOperatorBySupabaseSub("s1")` → that op+company; a second link with the same sub to a different op throws (UNIQUE). `slugFromEmail("Ann.Lee@acme.io")` → `ann-lee`; create a company with slug `ann-lee`, then `slugFromEmail` of another `ann.lee@…` returns `ann-lee-2`.

- [ ] **Step 2: Run — expect FAIL.** `npm run test --workspace @buildex/sync -- --run src/store/store.test.ts`
- [ ] **Step 3: Implement** the migration + methods. **Step 4: PASS.** **Step 5: typecheck + commit** (`feat(sync): map a Supabase user to a company-of-one (supabase_sub, find-or-create slug)`).

---

### Task 5: `ProvisioningService.provisionBySession`

**Files:**
- Modify: `apps/sync/src/provisioning/service.ts`
- Test: `apps/sync/src/provisioning/service.test.ts`

**Interfaces:**
- Consumes: private `mintMachine(operatorId, machineName)` (already exists); store methods from Task 4; existing `createCompany`/`createOperator`; an id generator (find how the S2S path makes company/operator ids — reuse it).
- Produces: `async provisionBySession(opts: { sub: string; email?: string; machineName: string }): Promise<Credentials>` — `findOperatorBySupabaseSub(sub)`; if found → `mintMachine(op, machineName)`. If not: derive slug (`slugFromEmail(email ?? "user")`), create company + first operator, `linkOperatorSupabaseSub`, ensure core repo, then `mintMachine`. Idempotent: same `sub` twice → same company, two distinct credentials.

- [ ] **Step 1: Write the failing test.** With a real (temp) store + service: `provisionBySession({sub:"s1", email:"a@acme.io", machineName:"m1"})` → Credentials with `machineToken`/`refreshToken`; the company now exists (repos `team-<slug>` + `private-<op>`). Call again same `sub`, `machineName:"m2"` → SAME company (assert the operatorId/companyId is unchanged), different machine token. A different `sub` → a different company.

- [ ] **Step 2: Run — expect FAIL.** `npm run test --workspace @buildex/sync -- --run src/provisioning/service.test.ts`
- [ ] **Step 3: Implement `provisionBySession`.** **Step 4: PASS.** **Step 5: typecheck + commit** (`feat(sync): provisionBySession - find-or-create a company-of-one and mint the machine token`).

---

### Task 6: `POST /session` route (dormant-safe) + verifier wiring

**Files:**
- Modify: `apps/sync/src/http/app.ts` (route + `AppDeps`)
- Modify: `apps/sync/src/main.ts` (construct the verifier from config when `signIn` present)
- Test: `apps/sync/src/http/app.test.ts`

**Interfaces:**
- Consumes: `verifyJwt` (Task 1), `makeJwksCache` (Task 2), `config.signIn` (Task 3), `provisioning.provisionBySession` (Task 5), the existing `withCloneUrls(deps, creds)` and `json()` helpers in `app.ts`.
- Produces: `AppDeps` gains optional `verifySession?: (jwt: string) => Promise<{ sub: string; email?: string }>` (undefined = dormant). Route: `POST /session`, body `{ jwt, machineName? }`. If `!deps.verifySession` → `json({error:"sign-in not configured"}, 501)`. Else `try { claims = await deps.verifySession(jwt) } catch { return json({error:"sign-in failed"}, 401) }`, then `creds = await deps.provisioning.provisionBySession({ sub: claims.sub, email: claims.email, machineName: b.machineName ?? "device" })`, return `json(withCloneUrls(deps, creds))` — the SAME shape `/provision` returns.

**Wiring (main.ts):** when `config.signIn` is set, build `const keys = makeJwksCache({ url: config.signIn.jwksUrl, fetch, now: Date.now })` and `verifySession = (jwt) => verifyJwt(jwt, { keys, now: Date.now, config: { issuer: config.signIn.issuer, audience: config.signIn.audience } })`; pass it into `createApp` deps. When unset, omit it (dormant).

- [ ] **Step 1: Write the failing test.** In `app.test.ts`: (a) with `verifySession` undefined → `POST /session` returns `501`. (b) with a fake `verifySession` that resolves `{sub:"s1", email:"a@acme.io"}` and a real (temp) provisioning/store → returns `200` with `{machineToken, refreshToken, repos:{core,team,private}}` (same shape as the `/provision` test asserts). (c) with a `verifySession` that rejects → `401`, and assert the store created NO company (a rejected JWT never provisions). (d) `GET`/other methods on `/session` → `405`/`404` per the file's convention.

- [ ] **Step 2: Run — expect FAIL.** `npm run test --workspace @buildex/sync -- --run src/http/app.test.ts`
- [ ] **Step 3: Implement** the route + `AppDeps` field + `main.ts` wiring. **Step 4: PASS** (app.test.ts + the whole sync suite). **Step 5: typecheck + commit** (`feat(sync): POST /session - verify a sign-in JWT and provision a company-of-one (501 when dormant)`).

---

### Task 7: Release gate `[release-gate:signin-jwt]`

**Files:**
- Create: `apps/sync/src/invariants/signin-jwt.test.ts` (mirror the repo's invariant-suite tagging convention — find an existing `[release-gate:*]` test and copy its shape)
- Modify: the invariants registry meta-check (the test that asserts the exact tagged set — grep `release-gate:` to find it) to expect the new tag; update any "N suites" wording.
- Test: the registry meta-check itself.

**Interfaces:** Consumes Task 1/6. Produces the tagged gate.

- [ ] **Step 1: Write the gate test** `[release-gate:signin-jwt]`: drive `verifyJwt` (and/or `POST /session`) with a FORGED token (signed by a different key than the JWKS advertises), an EXPIRED token, and a WRONG-ISSUER token; assert each is rejected (`JwtError` / `401`) and that no machine token is ever returned for them. This is the "a bad sign-in never mints a token" invariant.

- [ ] **Step 2: Run — expect it PASSES** against Task 1/6 code (RED-verify by the controller separately by breaking the check). Then update the registry meta-check to include `signin-jwt` (registry grows to its new count) and fix wording.

- [ ] **Step 3: Run the invariants suite** `task invariants` (or the workspace equivalent) → all release gates pass, registry meta-check green. **Step 4: commit** (`test(invariant): [release-gate:signin-jwt] - a forged/expired/wrong-issuer JWT never mints a token`).

---

### Task 8: Client sign-in flow (system browser + PKCE + loopback, seams)

**Files:**
- Create: `apps/client/src/account/sign-in.ts`
- Test: `apps/client/src/account/sign-in.test.ts`

**Interfaces:**
- Produces: `interface SignInDeps { openBrowser(url: string): void; loopback: LoopbackServer; supabase: SupabaseAuthClient; now: () => number; randomState(): string; pkce(): { verifier: string; challenge: string } }` and `async function signIn(deps: SignInDeps, cfg: { supabaseUrl: string; port?: number }): Promise<{ jwt: string }>`.
  - `interface LoopbackServer { listen(port: number): Promise<{ port: number; waitForCallback(): Promise<URL> }>; close(): void }` — starts a one-shot 127.0.0.1 listener; `waitForCallback` resolves with the redirect URL (has `code` + `state`).
  - `interface SupabaseAuthClient { authorizeUrl(args: { redirectUri: string; state: string; codeChallenge: string }): string; exchangeCode(args: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ jwt: string }> }`
- Flow: generate `state` (one-time) + PKCE; `loopback.listen(port ?? 54121)` (on EADDRINUSE, retry port 0 to get a free port — note the redirect URI must then be registered; for the fixed-port default document that 54121 is the registered callback); `openBrowser(supabase.authorizeUrl(...))`; `const cb = await waitForCallback()`; **validate `cb.searchParams.get("state") === state`** (one-time; reject otherwise with an error); `exchangeCode(code, verifier)` → `{ jwt }`. Enforce a TTL: if `waitForCallback` exceeds e.g. 5 min (via `now`), abort with an error. Always `loopback.close()` in a finally.

- [ ] **Step 1: Write the failing test.** All seams faked: `loopback` returns a canned callback URL with the SAME state the flow generated → `signIn` returns the exchanged jwt; a callback URL with a DIFFERENT state → rejects (state validation); `exchangeCode` is called with the verifier matching the challenge. Assert `openBrowser` was called with an authorize URL containing the challenge + state. No real network/browser.

- [ ] **Step 2: Run — expect FAIL.** `npm run test --workspace @buildex/client -- --run src/account/sign-in.test.ts`
- [ ] **Step 3: Implement `sign-in.ts`.** **Step 4: PASS.** **Step 5: typecheck + commit** (`feat(account): sign-in flow - system browser + PKCE + one-time-state loopback`).

---

### Task 9: `session-client` + shared persist→attach tail

**Files:**
- Create: `apps/client/src/account/session-client.ts`
- Modify: `apps/client/src/account/open-account.ts` (extract the shared persist→attach tail)
- Test: `apps/client/src/account/session-client.test.ts`, extend `apps/client/src/account/open-account.test.ts`

**Interfaces:**
- Consumes: `provision-client`'s result shape + `ProvisionError` pattern; `AccountStore`; `attachOrg`; `SyncEngine`.
- Produces:
  - `session-client.ts`: `async function postSession(deps: { fetch; baseUrl }, args: { jwt: string; machineName: string }): Promise<ProvisionResult>` — POST `/session`, same parse/guard/error discipline as `provision-client.ts` (unparseable body / non-2xx → typed error; success → validated `ProvisionResult`).
  - In `open-account.ts`, extract the shared tail `async function persistAndAttach(deps, baseUrl, result): Promise<{state:"connected"|"needs-help"}>` = `account.save(baseUrl, result)` → `attachOrg(...)` → map status. Both `openAccount` (setup code) and the new sign-in entry call it. Sandbox guard stays FIRST in each entry.

- [ ] **Step 1: Write the failing tests.** `session-client.test.ts`: mirrors `provision-client.test.ts` (200 happy path against fake fetch → ProvisionResult; 401 → typed error; unparseable 200 → typed error). `open-account.test.ts`: add a case that `persistAndAttach` on a real file:// bare set persists account.json + first-publishes the team ref (the same guarantees the existing openAccount happy-path test checks), proving the extraction preserved behavior.

- [ ] **Step 2: Run — expect FAIL.** `npm run test --workspace @buildex/client -- --run src/account/session-client.test.ts src/account/open-account.test.ts`
- [ ] **Step 3: Implement.** **Step 4: PASS.** **Step 5: typecheck + commit** (`feat(account): session-client + shared persist→attach tail for both entry points`).

---

### Task 10: Daemon `POST /api/signin` + wiring

**Files:**
- Modify: `apps/client/src/daemon/daemon.ts` (route + `DaemonDeps`)
- Modify: `apps/client/src/wiring.ts` (construct sign-in deps; assemble the signIn→postSession→persistAndAttach chain)
- Test: `apps/client/src/daemon/daemon.test.ts`

**Interfaces:**
- Consumes: `signIn` (Task 8), `postSession` + `persistAndAttach` (Task 9).
- Produces: `DaemonDeps` gains optional `signIn?: (input?: {}) => Promise<{ state: "connected" | "needs-help" }>`. Route `POST /api/signin`: if `deps.signIn` absent → `501`; else run it, map errors to `400`/`409` (sandbox) like `/api/account` does, never `500`. `wiring.ts` builds `signIn` as: `runSignIn(...) → postSession(jwt) → persistAndAttach(...)`, sandbox refused first; only wired when a `supabaseUrl` client config is present (else `/api/signin` stays dormant `501`, matching the backend).

- [ ] **Step 1: Write the failing test.** In `daemon.test.ts`: with `signIn` dep undefined → `POST /api/signin` → `501`; with a fake `signIn` resolving `{state:"connected"}` → `200 {state:"connected"}`; with one throwing a sandbox error → `409`; a generic throw → `400` (never `500`).

- [ ] **Step 2: Run — expect FAIL.** `npm run test --workspace @buildex/client -- --run src/daemon/daemon.test.ts`
- [ ] **Step 3: Implement** route + wiring. **Step 4: PASS + typecheck.** **Step 5: commit** (`feat(daemon): POST /api/signin - run the sign-in→attach chain (501 when unconfigured)`).

---

### Task 11: Console CTAs — left-rail pill, pending card, sign-in modal

**Files:**
- Create: `apps/client/web/js/signin.js` (the sign-in modal + `startSignIn()` calling `POST /api/signin`)
- Modify: `apps/client/web/index.html` (register `js/signin.js`), `apps/client/src/console-harness.ts` (expose new top-level functions)
- Modify: `apps/client/web/js/projects.js` or the left-rail renderer (persistent CTA pill when signed-out), the pending renderer `web/js/pending.js` (contextual card), and `web/js/account.js` (modal leads with Sign in; setup-code becomes secondary "Have a setup code?")
- Modify: `apps/client/web/styles/*.css` (pill + card styles)
- Test: `apps/client/src/console-signin.test.ts` (jsdom)

**Interfaces:** Consumes `POST /api/signin`, `GET /api/sync` (`unsaved.connected`, `unsaved.files`). Produces `function startSignIn()` (global; add to `console-harness.ts` EXPOSE, alphabetized), plus the two CTA renderers.

**Notes:** Follow the exact idioms already in the repo — `web/js/account.js` (the connect modal we shipped), `console-render-account.test.ts` / `console-connect-account.test.ts` (harness + `routeFetch`), `web/js/pending.js` (card rendering). Copy discipline: no `push`/`token`/`JWT` in visible strings; the field labels are "Sign in with Google", "Email me a link", "Have a setup code?".

- [ ] **Step 1: Write the failing test** `console-signin.test.ts`: (a) `startSignIn()` opens a modal offering "Sign in with Google" + an email option + a secondary "Have a setup code?" disclosure; (b) with `GET /api/sync` → `{unsaved:{connected:false, files:3}}`, the left-rail CTA pill AND the pending card render; with `{connected:true}` neither renders; (c) clicking the primary CTA POSTs `/api/signin` and, on `{state:"connected"}`, tears down + calls `refreshProjects`. No banned vocab in any rendered string.

- [ ] **Step 2: Run — expect FAIL.** `npm run test --workspace @buildex/client -- --run src/console-signin.test.ts`
- [ ] **Step 3: Implement** `signin.js` + the two CTAs + modal changes + CSS + harness EXPOSE + index.html tag. **Step 4: PASS** + the existing console suite (no regression to `console-connect-account`/`console-render-account`). **Step 5: typecheck + commit** (`feat(console): Sign in to back up & sync - left-rail CTA, pending card, sign-in modal`).

---

### Task 12: Deploy dormant + live regression

**Files:** none (operational). Optional: append a "Phase 3 deployed dormant" note to `infra/infrastructure.md`.

- [ ] **Step 1:** After Tasks 1–11 merge to main and `task ci` is green, deploy: `task deploy --yes` (the image now carries `/session`, dormant because no `BUILDEX_SUPABASE_*` secrets are set).
- [ ] **Step 2: Verify dormant + no regression:** `curl -sS https://<app>.fly.dev/healthz` → `{"ok":true}`; `curl -sS -X POST https://<app>.fly.dev/session -H 'content-type: application/json' -d '{}'` → `501 {"error":"sign-in not configured"}`; re-run the live dogfood provision→team-push→core-reject to confirm existing flows are byte-for-byte unaffected.
- [ ] **Step 3:** Append the deploy note + the owner "plug in Supabase" checklist (from the spec) to `infra/infrastructure.md`; commit; merge/push.
