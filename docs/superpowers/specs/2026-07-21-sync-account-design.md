# Sync accounts - design

**Date:** 2026-07-21
**Status:** approved design, not yet planned or implemented

Connect a local BuildEx workspace to a hosted sync service, so an operator's `core`, `team`, and
`private` roots become real git repos on a server they can be joined to from a second machine - and
so an operator reaches that state by signing in, not by pasting a secret.

## Why this spec exists

Both halves of sync are already built. The seam between them is empty.

`apps/sync` has the whole server: provisioning, the permission matrix (`core`=read,
`team-<slug>`=write, `private-<operatorId>`=write), machine and refresh tokens hashed at rest,
embedded bare repos served over git smart-HTTP, and a durable automations queue. It carries roughly
as many lines of test as of source, and its permission matrix is a release gate.

`apps/client` has the whole engine: `SyncEngine` (stage, commit, fetch, rebase, push, with a
conflict-backup path), `SyncScheduler` (debounce, offline backoff, background pull tick), a status
dot, and a fully implemented automations drain client.

What is missing is the wire:

| Gap | Evidence |
|---|---|
| No `git remote add` in client product code | remotes are never attached; status permanently reads `local` |
| Nothing calls `POST /provision` | `ClientConfig.automationsSync` is a seam no entrypoint populates |
| No credential path for authenticated push | no credential helper, no `GIT_ASKPASS`, no header injection |
| `"machine-token"` keychain key has no producer or consumer | referenced only by `invariants/secrets.test.ts` |
| `syncReadonly()` is never called | `SyncEngineLike` declares only `syncWritable`, so `core` never updates |
| `apps/sync` has no entrypoint and no Dockerfile | nothing binds a port; `compose.yml` references a build that cannot succeed |

This spec closes all six, and adds a browser sign-in front door.

## Decisions

Each decision below was argued before being taken; the rationale is recorded so a later change can
supersede it visibly rather than silently.

### 1. Attach remotes in place; never clone, never move

An operator who already has local work keeps it. For each root: `git remote add origin <url>`,
`git fetch`, then delegate to the engine that already exists - `syncReadonly()` for `core`,
`syncWritable()` for `team` and `private`.

Delegating rather than reimplementing is what makes this safe:

- **Empty upstream** (first operator): rebase onto nothing, push succeeds, full local history preserved.
- **Non-empty upstream** (second machine or second operator): the existing fetch → rebase → push path applies.
- **Divergent `core`** (local stub history vs cloud, and `core` is read-only by matrix): `backupAndReset()`
  copies the divergence to `.conflicts/<ts>/` and writes `.sync-needs-help` before resetting onto the
  remote. Invariant 8 is satisfied by already-tested code.

Attach is idempotent per root, so a partial failure is resumed by re-running rather than repaired by hand.

Rejected: cloning fresh alongside and migrating files in - it discards local history, doubles disk
during migration, and introduces a swap step with a window where work exists in one place only.
Rejected: refusing to provision a workspace that already has commits - it strands every existing
dogfooder.

### 2. The machine token reaches git through environment-only config

Git reads config from `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` (git >= 2.31).
The daemon injects an `http.extraHeader` Authorization header at spawn time and nowhere else.

- Nothing is written to disk, nothing enters `.git/config`, nothing appears in the process command
  line, so no `ps` leak.
- Identical on macOS, Windows, and Linux - no shell script, no `.cmd`, no platform-specific helper binary.
- `lib/git-pin.ts` is already the single chokepoint every git invocation passes through.

This is what keeps `scripts/secret-scan.sh` and `invariants/secrets.test.ts` honest: no token in a
remote URL, no token in git config, no token in a commit.

Rejected: `GIT_ASKPASS` (needs an on-disk executable, per-platform, and still needs the token handed
to it). Rejected: `credential.helper` (writes buildex state into every repo's config and needs a
platform-specific binary).

### 3. Accounts are per-org, and so are tokens

The client already supports multiple orgs (`<orgsRoot>/<orgId>/`, an `active-org` pointer, and a
sandbox org badged "never synced"). Each org is independently local-only or connected.

- Secrets: keychain keys `org:<orgId>:machine-token` and `org:<orgId>:refresh-token`.
- Non-secrets: `<orgsRoot>/<orgId>/account.json` - `companyId`, `operatorId`, `baseUrl`, and the
  local-root → remote-URL map. No token, ever.
- The sandbox org refuses to attach and stays local.

This costs a change to the flat `"machine-token"` convention asserted in `invariants/secrets.test.ts`,
which the spec updates. A single install-wide token was rejected: it breaks hard company isolation
(invariant 6) the moment an operator belongs to two companies.

### 4. Sign-in mints a setup token and does nothing else

`apps/site/src/apply.ts` shows the funnel is apply → founder approves → provision. There is no
self-serve signup by design.

So sign-in's only job is to prove identity once and hand over a one-time setup token. It keeps no
session, needs no password reset, no MFA, and no account recovery. Everything downstream of the
token - `/provision`, attach, sync - is identical whether the token was pasted or received over
loopback.

An email that does not resolve to an existing operator gets `403` and creates no state. Companies
and operators are still created by the founder over the existing S2S surface.

### 5. The IdP is a seam, Supabase is its first value

`apps/sync/src/identity/verify-jwt.ts` verifies a JWT against a configured JWKS. Configuration is
`BUILDEX_IDP_JWKS_URL` and `BUILDEX_IDP_ISSUER`, so Supabase is a value rather than a coupling and
any OIDC provider is a config change.

Verification uses `node:crypto` only - `createPublicKey({ format: "jwk" })` plus `crypto.verify`,
with `dsaEncoding: "ieee-p1363"` for ES256. **`apps/sync` keeps zero npm dependencies.**

Supabase is the IdP and nothing more. Companies, operators, machines, permissions, and repos stay in
`control.db` on the sync host. Putting control-plane data in Supabase Postgres was rejected: it
splits the source of truth in two and destroys the self-host story.

### 6. Hosting: Fly.io, because SQLite forbids the alternatives

`control.db` is SQLite in WAL mode. SQLite locking is unsafe on network filesystems; NFS/EFS lock
semantics are a documented route to WAL corruption.

**This rules out AWS Fargate + EFS, which is the only way Fargate gets persistence.** Anyone
revisiting hosting must not "simplify" onto network storage. ECS therefore means ECS-on-EC2 with EBS,
plus an ALB that costs more per month than every alternative considered.

Fly.io deploys the same Dockerfile phase 1 produces, gives a real block volume where both SQLite and
bare git repos behave normally, and terminates TLS itself - so **Caddy leaves the production path**
and `compose.yml` becomes the local development stack only. Roughly $5/month for one machine and a
10 GB volume.

Accepted trade-offs: a volume pins the app to one region with no HA on the cheap tier, which is fine
because a single-writer SQLite plus git host is inherently single-node; and `fly deploy` restarts the
machine, so pushes mid-deploy fail and retry, which the scheduler's existing offline backoff already
handles.

Litestream continues to replicate `control.db`, now to Cloudflare R2 - zero egress, S3-compatible so
`litestream.yml` barely changes, and `apps/site` is already on Cloudflare.

One shape change follows from Fly: a Fly machine runs a single container, so Litestream stops being a
compose sidecar and becomes the container entrypoint, wrapping the node process
(`litestream replicate -exec "node dist/main.js"`). That also gives the documented restore-then-serve
ordering for free on a cold start. The Dockerfile must therefore carry the Litestream binary.

### 7. Automations stay unwired

`tickOnce`, `gitDefReader`, and the client's `AutomationsClient` are all built and tested, but no
timer invokes the former and no entrypoint configures the latter. Wiring only the server half would
queue runs nobody claims. Both stay as they are; automations get their own spec.

## Architecture

```
OPERATOR'S LAPTOP - the only place anything thinks
  Electron app (apps/client)
    daemon 127.0.0.1:4317 · gateway 127.0.0.1:4318
      Claude Code agent      spawned here, always
      SyncEngine + Scheduler commit → fetch → rebase → push
      OS keychain            org:<orgId>:machine-token
  workspace/{core,team,private}   real git working trees, plain markdown
      origin = https://<sync-host>/git/<repo>.git

apps/site - Cloudflare Pages + Functions
  marketing, apply funnel, sign-in page. No git, no files, no disk.

IdP (Supabase) - mints a JWT. Stores no company data.

THE SERVER - one Fly.io machine
  sync (apps/sync) · node:22 · zero npm dependencies
    POST /provision           setup token → credentials + clone URLs
    POST /token/refresh       rotate the machine/refresh pair
    POST /api/setup-tokens    Bearer JWT → verify → operator → setup token
    POST /s2s/*               service-key gated, timing-safe
    GET|POST /git/*.git       spawns the real `git http-backend`
  PERSISTENT VOLUME /srv/buildex
    control.db                companies, operators, machines, permissions, audit
    repos/*.git               bare repos - the company's entire history
  litestream → Cloudflare R2 (backups only)
```

Files live on the Fly volume as ordinary bare git repos served by the real `git http-backend`
binary. Object storage holds backups only. `apps/site` is stateless and scales to zero; `apps/sync`
is stateful and shells out to a binary, so serverless is permanently unavailable to it.

## Phase 1 - the server runs for real

| File | Change |
|---|---|
| `apps/sync/src/main.ts` | new - the missing entrypoint |
| `apps/sync/Dockerfile` | new - multi-stage, alpine + git + litestream, `tsc` emit |
| `apps/sync/package.json` | add a `build` script (`tsc -p tsconfig.build.json`) |
| `infra/fly.toml` | new - one machine, one volume, TLS by Fly |
| `infra/compose.yml` | add `BUILDEX_PUBLIC_BASE_URL`; drop `BUILDEX_JWT_SECRET`; note it is now dev-only |
| `infra/litestream.yml` | retarget to R2 |
| `scripts/mint-setup-token.ts` | new - calls `/s2s/setup-tokens`, prints the token |
| `Taskfile.yml` | `task mint-setup-token`, `task deploy` via `fly deploy` |
| `infra/infrastructure.md` | topology, cost ledger, snapshot date - same session |

`main.ts` reads env, fails fast on a missing or short `BUILDEX_SERVICE_KEY`, opens
`ControlPlaneStore`, `ScheduleStore`, and `EmbeddedGitService`, then wires `createApp` →
`createNodeServer` → `listen`. On `SIGTERM` it closes the server **and both SQLite stores** - the
leak fixed in `ee770eb` makes that non-optional.

| Env | Default |
|---|---|
| `BUILDEX_SERVICE_KEY` | required |
| `BUILDEX_PUBLIC_BASE_URL` | required - `/provision` builds clone URLs from it |
| `BUILDEX_DATA_DIR` | `/srv/buildex` |
| `PORT` | `8080` |

Imports already use `.js` specifiers under `NodeNext`, so a plain `tsc` emit is clean and no
experimental type-stripping is needed.

**Done when:** `GET https://<sync-host>/healthz` succeeds over TLS and a bare repo clones from a
laptop using a hand-minted token.

## Phase 2 - the client seam

New directory `apps/client/src/account/`, five small single-purpose modules:

| File | Responsibility |
|---|---|
| `provision-client.ts` | `POST /provision` with an injected `fetch` |
| `account-store.ts` | `account.json` for non-secrets; keychain for the token pair |
| `token-provider.ts` | supplies the current token; rotates via `/token/refresh` on auth failure |
| `credentials.ts` | `gitAuthEnv(token)` → the `GIT_CONFIG_*` triple |
| `attach.ts` | add remote, fetch, delegate to the existing engine |

Changes to existing code, each closing a listed gap:

| Change | Closes |
|---|---|
| `SyncEngine` accepts a `TokenProvider`; `lib/git-pin.ts` merges the auth env | the credential gap |
| `SyncEngineLike` gains `syncReadonly`; the scheduler calls it for `core` on the pull tick | `core` never updating |
| `writableDirs` moves from `name !== "core"` to the existing `slotOf()` | two competing notions of team/private |
| `GET /api/sync` returns per-root status alongside the collapsed worst | UI cannot say which root is stuck |
| `invariants/secrets.test.ts` updated for the per-org keychain key | decision 3 |

Daemon: `POST /api/account { baseUrl, setupToken }` runs provision → attach → first flush.
`GET /api/account` returns `{ state: "local" | "connected", companyId?, operatorId?, remotes? }`.

UI: `web/js/onboarding.js` replaces "Team sync accounts are coming" with a token field;
`web/js/sync.js` retires the `local` copy once connected.

The paste path is **permanent**, not scaffolding. It is the offline escape hatch and the path the
tests drive.

**Done when:** a laptop's `team/` pushes to the deployed service and a `core/` push is rejected by
the matrix.

## Phase 3 - sign-in

| File | Change |
|---|---|
| `apps/sync/src/identity/verify-jwt.ts` | new - JWKS fetch and cache, ES256/RS256 via `node:crypto` |
| `apps/sync/src/http/app.ts` | new route `POST /api/setup-tokens`, Bearer JWT gated |
| `apps/sync/src/store/store.ts` | `findOperatorByEmail`, plus a `UNIQUE` index on `operators.email` |
| `apps/site/src/connect.ts` + page | sign-in page and the Function that keeps the browser same-origin |
| `apps/client/src/daemon/daemon.ts` | account callback on loopback, reusing the existing one-time-state machinery |
| `apps/client/web/js/onboarding.js` | a Connect button beside the paste field |

`verify-jwt.ts` checks `iss`, `aud`, `exp`, and `email_verified`, then returns the verified email.
The route resolves that email to an operator and mints a setup token; an unknown email returns `403`
with no state created.

`operators.email` exists already but is not unique. The index is required, because an email
resolving to two operators makes sign-in ambiguous.

The loopback half is not new work: `daemon.ts:80-93` already implements validated one-time state and
callback handling for connector OAuth, and `electron/external-url.ts` already treats
`127.0.0.1:<port>/oauth/*/callback` as internal while sending everything else to the system browser.

```
app → browser → site sign-in (Supabase / Google)
                     ↓ JWT
              site Function /api/connect
                     ↓ Bearer JWT
              sync POST /api/setup-tokens → verify → email → operator → setup token
                     ↓
   http://127.0.0.1:<port>/oauth/account/callback?state=…&token=…
                     ↓
              daemon: validate one-time state → /provision → attach → sync
```

**Done when:** an operator clicks Connect, signs in with Google, and their workspace syncs without
ever seeing a token.

## Error handling

| Case | Behaviour |
|---|---|
| Local `core` diverges from cloud | `.conflicts/<ts>/` plus `.sync-needs-help`, then reset onto the remote |
| Attach fails partway through | Per-root and idempotent; re-running skips already-attached roots |
| Machine token expired or revoked | `token-provider` rotates via `/token/refresh`, retries once, then surfaces `needs-help` |
| Signed-in email is not an operator | `403`, no state created |
| Sandbox org | Refuses to attach; stays local and stays badged |
| Setup token reused or expired | Already rejected server-side; asserted by test |
| Service unreachable | Existing offline backoff; status shows `queued`, work is never lost |
| Unrelated histories on `team` | Rebase surfaces conflict → existing `backupAndReset()` path |

## Testing

Hermetic units for every new module, with injected `fetch`, `Clock`, `Keychain`, and temp
directories. No network in unit lanes.

- `attach` runs against `file://` bare repos covering all three upstream states.
- `verify-jwt` runs against a locally generated keypair, with expiry, wrong issuer, wrong audience,
  unverified email, and tampered-signature cases.
- `scripts/cross-module-smoke.ts` extends to the full flow against the real handler over a real
  socket with real git.

**New release gate: `[release-gate:no-token-on-disk]`.** After a complete account-open and sync, the
test greps the entire workspace, every `.git/config`, and `account.json` for the machine-token
prefix. This is the invariant the `GIT_CONFIG_*` approach exists to protect, so a regression to a
credential helper or a URL-embedded token must fail the build.

`apps/sync` remains excluded from the Windows CI lane (a pre-existing SQLite handle issue in
teardown); the client account modules are not excluded and must pass there.

## Out of scope

- Automations wiring, server-side or client-side (decision 7).
- Seats, billing, and any admin surface.
- Multi-operator invites - sign-in resolves existing operators only (decision 4).
- Disconnecting an account or rotating a company; revoke already exists server-side.
- Client release signing and auto-update.
- Repo backup transport for `/srv/buildex/repos`; `infra/litestream.yml` references a snapshot script
  that does not exist. Tracked as a phase 1 follow-up, not a blocker.

## Settled details that the plan should not relitigate

- `account.json` records the clone URLs exactly as `/provision` returned them, alongside `baseUrl`.
  The server owns repo naming, so the returned URLs are authoritative and the client never
  reconstructs them. Moving the service to a new host is a re-attach, which is out of scope here.
- Per-root status is shaped in the sync layer: the scheduler already computes per-root results and
  only collapses them in `worstStatus()`, so it returns the map and `GET /api/sync` serializes it.
  The daemon gains no logic.

## Open item for the implementation plan

1. Fly volume sizing, and whether `repos/` and `control.db` share one volume or two. This needs a
   real-world size estimate rather than a design argument, so it is deliberately deferred to the
   plan rather than guessed here.
