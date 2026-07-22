# BuildEx - infrastructure living map

> **Cataloguing rule:** every infra change lands here - topology + cost ledger + snapshot date -
> in the same session it happens. **This repo is public: structure and placeholders only.**
> No real hosts, IDs, or costs.

**Snapshot date:** 2026-07-22 (sync service DEPLOYED live on Fly + Tigris; end-to-end verified over
real HTTPS: provision → clone/push `team` succeeds → push `core` rejected 403 → Litestream replicating.
Phase 3 self-serve sign-in (`POST /session`) deployed **dormant** the same day - see the sign-in bullet).

## Deploy stack

- **Production: Fly.io**, one machine, one volume (`infra/fly.toml`). Fly terminates TLS, so there is
  no reverse proxy in the production path. `auto_stop_machines` is off and `min_machines_running` is
  1: a single-writer SQLite + git host is inherently single-node and a second machine would corrupt
  state.
- **Why not ECS/Fargate:** `control.db` is SQLite in WAL mode, and SQLite locking is unsafe on
  network filesystems. That rules out Fargate + EFS, the only way Fargate gets persistence. Anyone
  revisiting hosting must not move this onto network storage.
- **Image:** `apps/sync/Dockerfile`, multi-stage, build context = repository root. The runtime stage
  carries no `node_modules` (apps/sync has zero dependencies) plus `git`, `git-daemon`, and
  `litestream`. **`git-daemon` is load-bearing:** on Alpine the `git-http-backend` CGI the smart-HTTP
  service spawns ships ONLY in the `git-daemon` subpackage, not `git`. Installing `git` alone passes
  every hermetic test (none spawn http-backend) and then 500s every real clone/push - it cost a live
  deploy to find. Do not "simplify" the Dockerfile back to `apk add git`.
- **Litestream** runs as the container entrypoint (`apps/sync/entrypoint.sh`), gated on
  `LITESTREAM_ENDPOINT` being configured - a Fly machine runs one container, so it cannot be a
  sidecar. When an endpoint is set, `litestream restore -if-db-not-exists -if-replica-exists` runs
  first for both `control.db` and `schedules.db`, then entrypoint.sh `exec`s into
  `litestream replicate -exec "node ..."` (`litestream replicate -exec` alone never restores
  anything; the separate restore step is what gives restore-before-serve ordering on a cold start).
  When no endpoint is configured, entrypoint.sh skips litestream entirely and runs node directly.
  Production always sets an endpoint, so production is always replicated. Backend in use: **Fly Tigris**
  (S3-compatible object storage, zero egress) - `fly storage create` provisions the bucket and sets
  the `AWS_*` credentials as app secrets; litestream.yml reads bucket/endpoint from `LITESTREAM_BUCKET`
  / `LITESTREAM_ENDPOINT` (set to mirror those) and picks up the keys from the `AWS_*` env. Cloudflare
  R2 remains a drop-in alternative (same four LITESTREAM_* / AWS_* env), if zero-egress-at-scale wins.
- **Local development:** `infra/compose.yml`, one service, no proxy, no sidecar, unreplicated by
  default - `LITESTREAM_ENDPOINT`/`LITESTREAM_BUCKET`/credentials have no default value, so a
  developer must opt in via `infra/.env` to exercise replication locally.
- **Deploy:** `task deploy:plan` (build only) → `task deploy` (prompted).
- **Onboarding:** `task mint-setup-token -- --base-url https://<host> --onboard ...` (S2S admin path).
- **Self-serve sign-in (Phase 3, DEPLOYED DORMANT):** `POST /session` verifies a Supabase JWT
  (`node:crypto` only, zero-dep) → find-or-create company-of-one → the SAME machine token `/provision`
  mints. Ships **dormant** (`501 "sign-in not configured"`) until `BUILDEX_SUPABASE_JWKS_URL` /
  `BUILDEX_SUPABASE_ISSUER` / `BUILDEX_SUPABASE_AUDIENCE` are all set (all-or-nothing) - verified live
  that the dormant deploy is a no-op (existing `/provision` + git push/reject unchanged). **Owner
  cutover:** create a Supabase project (Google provider - email magic-link is deferred, Google-only
  shipped), allow-list the loopback redirect `http://127.0.0.1:54121/auth/callback`, `fly secrets set`
  the three vars + `task deploy`, then put the Supabase URL + anon key into the client config. Full
  checklist + decisions: `docs/superpowers/specs/2026-07-22-self-serve-signin-sync-design.md`.
- **Backups:** Litestream (control.db + schedules.db, continuous) → Tigris. The `buildex_data` volume
  has **scheduled daily snapshots enabled (retention 5)**, which cover `/srv/buildex/repos` as the
  interim answer; a repo-level continuous backup (not just point-in-time volume snapshots) remains a
  future refinement.
- **Cost ledger (placeholders - public repo):** one shared-cpu machine + one small volume + object
  storage at the free tier. Order of magnitude: single-digit USD per month.

## Topology (target)

Launch phase: the marketing site is a static Eleventy build on Cloudflare Pages; the `/apply`
waitlist is a Pages Function that stores submissions in a KV namespace (binding `WAITLIST`) the
operator reads out of band. When the hosted sync service ships, `/apply` moves to the S2S forward
below (see `apps/site/src/apply.ts`), closing the dogfood loop.

```
buildexponential.org (Cloudflare Pages)  ──POST /apply──▶  Pages Function ──▶  KV (WAITLIST)   [launch]
                                          ······ future ···▶  edge fn ──S2S──▶  sync
                                                             │
        ┌────────────────────────────────────────────────────┘
        ▼
sync (one Fly.io machine, one volume; Fly terminates TLS - see infra/fly.toml)
  ├─ BuildEx sync service (identity JWT · git smart-HTTP over bare repos · permission matrix
  │                     · core-pack publish · admin console)
  ├─ SQLite (WAL): /srv/buildex/control.db      ← Litestream (continuous) → R2
  ├─ SQLite (WAL): /srv/buildex/schedules.db    ← Litestream (continuous) → R2
  └─ bare repos:   /srv/buildex/repos           ← no automated backup yet (outstanding, see below)

client (Electron, per operator machine)
  └─ local daemon: agent driver · sync engine · connectors · policy/gate · map/history renderers
```

## Cost ledger

| Component | Provider | Sizing | Monthly (placeholder) | Notes |
|---|---|---|---|---|
| sync machine | Fly.io | one shared-cpu machine (1 cpu, 2GB, `infra/fly.toml` `[[vm]]`) + one volume | `$-` | region set at deploy time; sized for in-memory packfile buffering, see `[[vm]]` comment |
| object storage (backups) | Fly Tigris | Litestream target (control.db + schedules.db) | `$-` | S3-compatible, zero egress |
| DNS | Cloudflare | buildexponential.org | `$-` | registrar + DNS |
| site hosting | Cloudflare Pages | static Eleventy build + `/apply` Pages Function | `$-` | free tier at launch |
| waitlist store | Cloudflare KV | `WAITLIST` namespace | `$-` | launch-phase `/apply` capture |

## Restore drill (release-checklist item)

A rehearsed restore drill must recover the bare repos + `control.db` onto a clean machine from object
storage. Not yet exercised on live infra - status tracked here when the stack deploys.
