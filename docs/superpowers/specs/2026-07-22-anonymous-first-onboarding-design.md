# Anonymous-First Onboarding — Design

**Status:** approved-by-delegation (owner set: full autonomy build→merge→push→deploy-dormant, scope = this doc). Extends the dormant Phase 3 (`2026-07-22-self-serve-signin-sync-design.md`); nothing live changes until the owner's Supabase cutover.

**Goal:** Get an operator onto cloud backup in one screen — type a company name, keep "back up to the cloud" (the default), and they're synced instantly with **no browser, no Google, no password** — via a Supabase **anonymous** user. Google linking (recoverability + team sharing) is offered later.

**One sentence:** The client calls Supabase `signInAnonymously()` (a plain API call — no OAuth), sends that JWT + the typed company name to the existing `POST /session`, which names the company-of-one and mints the same machine token; the whole thing is dormant until Supabase is configured.

## Why this shape
- **Zero friction:** anonymous sign-in is a direct request, so first-run is one screen (name + a default choice), not an OAuth dance. This is the fastest possible path to "your work is backed up."
- **Reuses Phase 3 almost entirely:** `POST /session` already verifies a Supabase JWT and find-or-creates a company-of-one; an anonymous JWT has the same `iss`/`aud`/signature (just `is_anonymous: true`, no email), so it verifies unchanged. The only backend delta is threading a `companyName` for the slug + display name.
- **Google becomes the upgrade, not the gate:** later, `linkIdentity('google')` attaches Google to the *same* anonymous user (same `sub` → same company), turning "backed up" into "recoverable anywhere + shareable with your team."

## Honest safety model (drives the copy)
An anonymous cloud account is **backed up on the server** (the operator, as admin, holds the repos + Litestream backups) — genuinely safer than local. But it is tied to this device's session **until Google is linked**; lose the device before linking and recovery needs admin help. So:
- The default option promises **"Back up to the cloud"** (true from the first second), with a gentle **"Later, link Google so you never lose access and can invite your team."**
- It must NOT promise "safe forever." Linking is what turns backup into ownership.

## Scope (this build) vs. deferred

**In scope (build now):**
1. `POST /session` accepts an optional `companyName` → drives the company slug + display name.
2. `provisionBySession` accepts `companyName`; a new `slugFromName(name)` (slugify + dedup, mirroring `slugFromEmail`) sets the slug; the company's display `name` is the typed value. Email/no-name paths unchanged.
3. Client `SupabaseAuthClient.signInAnonymously()` seam + real GoTrue adapter (owner-verified at cutover).
4. Client `signUpAnonymous({ companyName })` flow: anon sign-in → `postSession({ jwt, companyName, machineName })` → `persistAndAttach` (sandbox refused first). Hermetic behind seams.
5. Daemon `POST /api/onboard { companyName }` runs it; dormant (`501`) when Supabase isn't wired (mirrors `/api/signin`).
6. First-run dialog: a **Company name** field + **cloud (default) / local (secondary)** choice with the honest copy. The cloud option appears only when `signInAvailable` (the daemon flag Phase 3 already surfaces); when dormant, the dialog is local-only — so today's first-run is unchanged.

**Deferred (documented follow-up — needs live Supabase to build + verify):**
- **Link-Google upgrade:** `linkIdentity` on the persisted anonymous Supabase session. This is what delivers "never lose access + invite your team." It requires (a) persisting the Supabase session (refresh token → keychain, per-org), and (b) the GoTrue identity-link flow over the existing loopback. Not built now (nothing would consume a persisted session yet — that'd be dead code); it is the immediate next piece before any real launch, because the onboarding copy promises it.
- **Org invites / team sharing** — already a Phase 3 fast-follow.

## Backend delta (`apps/sync`)
- `app.ts` `/session`: body gains `companyName?: string`; pass it to `provisionBySession`. (Dormant/verify/401 ordering all unchanged — companyName is only read on the success path.)
- `service.ts` `provisionBySession({ sub, email?, companyName?, machineName })`: if `companyName` present → `slug = store.slugFromName(companyName)`, company `name = companyName`; else current `slugFromEmail(email ?? "user")` path. Sequential slug→create (no intervening await) preserved (TOCTOU).
- `store.ts` `slugFromName(name)`: slugify (lowercased, non-alphanumerics → `-`, collapsed/trimmed, empty → `"company"`) + the same suffix-dedup `slugFromEmail` uses (factor the shared slug/dedup helper rather than duplicate).
- **Anonymous JWTs need no verify change.** No `is_anonymous` tracking in v1 (the `sub` mapping is enough; linking keeps the same `sub`).

## Client delta (`apps/client`)
- `sign-in.ts` `SupabaseAuthClient` interface gains `signInAnonymously(): Promise<{ jwt: string }>`. (We use only the JWT now; the session/refresh token is the deferred link feature's concern.)
- `real-seams.ts` `realSupabaseAuthClient`: implement `signInAnonymously` against GoTrue's anonymous sign-in (`POST /auth/v1/signup` with an empty credential body, apikey = anon key), returning the `access_token` as `jwt`. Errors typed; comment it owner-verified at cutover, same as the OAuth adapters.
- `account/anonymous.ts` (new) `signUpAnonymous(deps, { companyName })`: `sandbox` refused first → `supabase.signInAnonymously()` → `postSession({ fetch, baseUrl }, { jwt, companyName, machineName })` → `persistAndAttach(...)`. Reuses Task-9's shared tail. Hermetic (fake `supabase`).
- `daemon.ts` `POST /api/onboard`: body `{ companyName }`; `!deps.onboard → 501`; else run, map sandbox → 409 / else → 400 / never 500 (mirror `/api/signin`). `DaemonDeps.onboard?`.
- `wiring.ts`: build `onboard` only when Supabase client config present (dormant otherwise); it composes `signUpAnonymous` with the real `realSupabaseAuthClient` + `postSession` + `persistAndAttach`, sandbox first.
- First-run dialog (web/js): a small "Welcome — name your company" dialog with the Company name field + the two radio options (cloud default / local). Cloud option present + default only when `GET /api/sync`.`signInAvailable`; else local-only. Cloud → `POST /api/onboard { companyName }` → on `connected`, refresh the sync surface. Operator copy only (no push/commit/token/JWT).

## Dormancy & invariants
- **Dormant-safe:** no Supabase config → `/api/onboard` 501, the dialog is local-only, `/session`'s new `companyName` is an unused optional. Today's deploy stays a no-op; verified live like Phase 3.
- **No new on-disk secret** (the deferred link feature owns Supabase-session persistence). The machine token path is unchanged → `no-token-on-disk` gate holds.
- **Isolation:** each anonymous `sub` → its own company-of-one; two anon users never share a company; `slugFromName` dedup means two "Acme"s get `acme` + `acme-2`, isolated.
- **Zero deps** in `apps/sync`; hermetic tests throughout.
- **`[release-gate:signin-jwt]` still holds** — a forged/expired/wrong-issuer JWT (anonymous or not) never mints a token; `/session`'s verify path is unchanged.

## Owner cutover — two additions to the Phase 3 checklist
- In the Supabase project, **enable "Anonymous sign-ins."**
- Turn on **CAPTCHA and/or rate-limiting** for sign-ups — anonymous signup is open to the internet, so this guards against mass-signup abuse.
- (Everything else — JWKS/issuer/audience secrets, Google provider, client Supabase config — is the Phase 3 checklist.)

## Decisions log (autonomous calls)
- **Anon-first, Google-as-upgrade** (per owner). Anon needs no browser; Google linking is the deferred recoverability/sharing step.
- **Company name up front** drives a real slug/display name (`team-<yourname>`), not `team-user`.
- **Don't persist the Supabase session yet** — nothing consumes it until the link feature; persisting a secret nothing reads is dead code. The link follow-up owns it.
- **Cloud option gated on `signInAvailable`** so the dormant first-run is unchanged (local-only today).
- **No `is_anonymous` column** — the `sub`→company map is sufficient and survives linking.
