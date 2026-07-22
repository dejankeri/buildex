# Self-Serve Sign-In & Sync — Design

**Status:** approved-by-delegation (owner off; owner set: full autonomy build→merge→push→deploy-dormant,
scope = this doc only). Review async; the Decisions Log records every call made without a live answer.

**Goal:** Turn "run a CLI to mint a setup code" into "open the app, use it locally, click *Sign in* (free)
to back up & sync your company brain" — a self-serve front door on top of the already-deployed sync service.

**One sentence:** Supabase authenticates the human and hands back a JWT; a new `POST /session` on the
sync service verifies that JWT and maps it to a find-or-create company-of-one, minting the same machine
token the S2S `/provision` path already mints — so everything downstream (repos, permission matrix,
`attachOrg`, tokens-off-disk) is unchanged.

## Foundational model (approved, Section 1)

- **Hosted, multi-tenant.** Every free user's company-of-one lives on the ONE sync service the operator
  runs (today: the Fly instance). The service is already per-company isolated; this changes nothing about
  isolation, only who provisions (self-serve vs admin S2S).
- **Supabase is a thin front door**, not a new backend. Its only job: prove a human's identity and issue a
  signed JWT. The sync service remains the git + permission + token engine.
- **Company-of-one, org-ready.** First sign-in silently provisions a company owned by the user; "share with
  your org" (invite/join) is a designed-for **fast-follow**, not in this v1. The data model already holds
  many operators per company, so no migration is needed to add invites later.

## Global constraints (binding — copy verbatim into task briefs)

- **Zero npm dependencies in `apps/sync`.** JWT verification MUST use `node:crypto` only (Node 22 supports
  `crypto.createPublicKey({ key: <JWK>, format: "jwk" })` and RS256/ES256 verify). NO `jose`, NO new dep.
  JWKS fetch uses the injected `fetch`. If this cannot be met, STOP and escalate — do not add a dependency.
- **Identity from JWT only (inv 7).** Loopback redirects validated; the OAuth `state` is one-time and
  short-TTL. Machine tokens are minted server-side, never derived client-side.
- **Machine token never on disk / in a URL / in argv / in a commit** — only as a `GIT_CONFIG_*`
  `http.extraHeader`. The `no-token-on-disk` release gate must still pass.
- **Conductor bright-line (inv 4)** is about the *agent's model* credentials — a different axis. Company
  auth (Supabase) does not touch it. Do not render or proxy any *model/agent* provider sign-in.
- **Never lose an operator's work (inv 8).** Sign-in triggers `attachOrg`, which attaches local roots in
  place and first-publishes — the existing zero-loss path. No local work is discarded on sign-in.
- **Dormant-safe deploy.** With Supabase config absent, `/session` returns `501` and every existing route
  is byte-for-byte unaffected. Deploying this ahead of a real Supabase project must be a no-op for live users.
- **Hermetic tests, DI seams.** No network in unit lanes. JWT verify, JWKS, OAuth, and the loopback listener
  all sit behind injectable interfaces with test doubles.
- Operator-facing copy only: never `push`/`commit`/`branch`/`merge`/`diff`/`token`/`JWT` in visible strings.

## Architecture

```
Client (Electron)                     Supabase                 Sync service (Fly) — engine UNCHANGED
─────────────────                     ────────                 ─────────────────────────────────────
click "Sign in"  ──system browser──▶  OAuth (Google) / email
  PKCE + one-time state                 ↳ signed JWT (access token)
   ◀── loopback 127.0.0.1:<fixed>/auth/callback?code=… (state validated, one-time, short TTL)
        │  exchange code → Supabase session (JWT)
        └─ daemon POST {jwt} ─▶  NEW  POST /session
                                   1. verify JWT: sig via JWKS (node:crypto), iss/aud/exp  → 401 on any failure
                                   2. find-or-create company-of-one for sub/email (control.db)
                                   3. mint machine+refresh tokens (reuse provision internals)
        ◀── { machineToken, refreshToken, repos:{core,team,private} }  (SAME shape as /provision)
        └─ store machine token (keychain), then attachOrg() → local brain syncs up, zero loss
```

### New backend pieces (`apps/sync`)

1. **`jwt-verify.ts`** — `interface JwtVerifier { verify(jwt: string): Promise<Claims> }`. Default impl uses
   `node:crypto`: parse header→pick `kid`, resolve the JWK from a **JwksCache**, `createPublicKey`, verify
   RS256/ES256 over `header.payload`, then check `iss` === configured issuer, `aud` === configured audience,
   `exp`/`nbf` against an injected clock. Any failure → typed `JwtError` (never a generic throw). Fully
   hermetic: tests generate a keypair, sign a token, expose a one-key JWKS via a fake fetch.
2. **`jwks-cache.ts`** — fetch the JWKS from the configured URL via injected `fetch`, cache by `kid` with a
   TTL + a single-flight refetch on unknown `kid` (key rotation). Injected clock for TTL.
3. **config** (extend `apps/sync/src/config.ts`) — optional `BUILDEX_SUPABASE_JWKS_URL`,
   `BUILDEX_SUPABASE_ISSUER`, `BUILDEX_SUPABASE_AUDIENCE`. If any required one is absent, sign-in is
   **dormant** (config carries `signIn: undefined`); present → `signIn: { jwksUrl, issuer, audience }`.
   Never weakens the existing required-key validation.
4. **identity mapping** (control.db) — a migration adding `operator.supabase_sub` (unique, nullable) and a
   find-or-create: given verified `{ sub, email }`, look up by `sub`; if absent create a company-of-one
   (slug derived from email local-part, de-duped) + operator, storing `sub`. Idempotent: same `sub` always
   resolves to the same company. A second device is just another `/session` → same company, new token.
5. **`POST /session`** (extend `apps/sync/src/http/app.ts`) — body `{ jwt }` (or `Authorization: Bearer`).
   Dormant (no config) → `501 {"error":"sign-in not configured"}`. Verify → on `JwtError` `401`. Then
   find-or-create → mint tokens via the SAME internal path `/provision` uses → return the SAME JSON shape.
   Reuses the machine-token minting and repo-URL builder verbatim; no divergence from `/provision`'s output.

### New client pieces (`apps/client`)

6. **`account/sign-in.ts`** — `signIn({ openBrowser, loopback, supabase, sessionExchange })`: start a
   one-time loopback listener (fixed port, fallback if busy), generate PKCE verifier + one-time state (TTL),
   open the system browser to Supabase's authorize URL, await the callback, validate state, exchange the
   code for a Supabase session (JWT). All four collaborators are injected seams (hermetic tests use fakes;
   no real browser/network). Returns the JWT.
7. **wire into the account seam** — the daemon takes the JWT → `POST /session` on the sync service (reuse
   `provision-client` shape via a sibling `session-client.ts`) → `AccountStore.save` → `attachOrg`. This is
   the SAME persist→attach chain as `open-account.ts`; factor the shared tail so both entry points (setup
   code, sign-in) converge. Sandbox org still refused first.
8. **daemon route** — `POST /api/signin` starts the flow and returns `{state:"connected"|"needs-help"}`;
   `GET /api/account` already reports state. Setup-code path (`POST /api/account`) stays as admin fallback.
9. **Left-rail CTA** — a persistent, dismissible-per-session "Back up & sync — sign in (free)" pill at the
   top of the left rail, rendered only when `unsaved.connected` is false. Click → `POST /api/signin`.
10. **Pending-panel CTA** — a contextual card in the pending tray shown only when signed-out AND there is
    real local work (`unsaved.files > 0`): "Your work only lives on this machine. Sign in free to back it up."
    Click → same flow. Reuses the existing pending-card rendering idiom; jsdom-tested.
11. **Sign-in modal** — the connect surface (sync-dot / onboarding) leads with "Sign in with Google" +
    "Email me a link"; "Have a setup code?" is a secondary disclosure (keeps the admin path).

## Testing & invariants

- **Backend hermetic:** keypair-signed JWT round-trips; bad signature / wrong `iss` / wrong `aud` / expired
  → `401`; JWKS `kid` rotation refetches once; find-or-create idempotency (same `sub` → same company; two
  `sub`s → two companies); dormant mode → `501`; `/session` output equals `/provision` output shape.
- **New release gate `[release-gate:signin-jwt]`** — a forged/expired/wrong-issuer JWT never yields a
  machine token. Added to the invariants registry (grows 6→7; the registry meta-check updated).
- **Existing gates hold:** `no-token-on-disk` (machine token still header-only), per-org isolation,
  manual-save behavior. `task ci` green including the cross-module smoke.
- **Client hermetic:** `sign-in.ts` against fake browser/loopback/supabase seams; the two CTAs + modal in
  jsdom via `console-harness`; the persist→attach convergence covered like `open-account.test.ts`.
- **Live regression post-deploy:** `/healthz`, and the dogfood company's provision→push/pull still work
  (dormant `/session` returns 501, changes nothing).

## What you plug in when back (the handoff checklist)

1. Create a Supabase project; enable **Google** provider + **email** magic-link.
2. Add the loopback redirect URL (`http://127.0.0.1:<fixed>/auth/callback`) to Supabase's allowed redirects.
3. `fly secrets set BUILDEX_SUPABASE_JWKS_URL=… BUILDEX_SUPABASE_ISSUER=… BUILDEX_SUPABASE_AUDIENCE=… --app <app>`
   then `task deploy` — `/session` goes from `501` to live.
4. Drop the Supabase project URL + anon key into the client config (single place; documented in the plan).

## Decisions Log (calls made without a live answer — override any on review)

- **Providers:** Google OAuth + email magic-link in v1 (the two a non-technical operator expects). More
  providers are config, not code.
- **Desktop flow:** system browser + PKCE + fixed-port loopback (not a webview — Google blocks webview OAuth
  and it's less secure). Fixed port with a free-port fallback; state one-time + short TTL (inv 7).
- **JWT lib:** none — `node:crypto` only, to preserve `apps/sync`'s zero-dependency property. RS256 + ES256.
- **Identity key:** Supabase `sub` (stable), with `email` for the derived slug + display only. Re-sign-in and
  new devices resolve to the same company by `sub`.
- **Company slug:** derived from email local-part, de-duplicated (`acme`, `acme-2`, …); not user-chosen in
  v1 (naming/rename is a fast-follow with invites).
- **Setup-code path retained** as the admin/S2S fallback; sign-in is the primary front door, not a replacement.
- **CTA insistence:** never modal/blocking; left-rail pill always (signed-out), pending card only when there's
  real local work. Local-first use is never gated behind sign-in.
- **Deploy posture:** ship dormant (501 without config); the live cutover is the owner's `fly secrets` + deploy.
