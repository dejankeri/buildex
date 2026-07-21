# BuildEx - infrastructure living map

> **Cataloguing rule:** every infra change lands here - topology + cost ledger + snapshot date -
> in the same session it happens. **This repo is public: structure and placeholders only.**
> No real hosts, IDs, or costs.

**Snapshot date:** 2026-07-21 (sync service deployable; Fly target authored).

## Deploy stack

- **Production: Fly.io**, one machine, one volume (`infra/fly.toml`). Fly terminates TLS, so there is
  no reverse proxy in the production path. `auto_stop_machines` is off and `min_machines_running` is
  1: a single-writer SQLite + git host is inherently single-node and a second machine would corrupt
  state.
- **Why not ECS/Fargate:** `control.db` is SQLite in WAL mode, and SQLite locking is unsafe on
  network filesystems. That rules out Fargate + EFS, the only way Fargate gets persistence. Anyone
  revisiting hosting must not move this onto network storage.
- **Image:** `apps/sync/Dockerfile`, multi-stage, build context = repository root. The runtime stage
  carries no `node_modules` (apps/sync has zero dependencies) plus `git` (spawned for smart-HTTP)
  and `litestream`.
- **Litestream** runs as the container entrypoint wrapping the node process - a Fly machine runs one
  container, so it cannot be a sidecar, and wrapping gives restore-before-serve on a cold start.
  Target: Cloudflare R2 (S3-compatible, zero egress).
- **Local development:** `infra/compose.yml`, one service, no proxy, no sidecar.
- **Deploy:** `task deploy:plan` (build only) → `task deploy` (prompted).
- **Onboarding:** `task mint-setup-token -- --base-url https://<host> --onboard ...`.
- **Backups:** Litestream (control.db, continuous) → R2. **Repo snapshots are still outstanding** -
  `/srv/buildex/repos` has no automated backup yet; Fly volume snapshots are the interim answer.
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
  └─ bare repos:   /srv/buildex/repos           ← no automated backup yet (outstanding, see below)

client (Electron, per operator machine)
  └─ local daemon: agent driver · sync engine · connectors · policy/gate · map/history renderers
```

## Cost ledger

| Component | Provider | Sizing | Monthly (placeholder) | Notes |
|---|---|---|---|---|
| sync machine | Fly.io | one shared-cpu machine + one volume | `$-` | region set at deploy time |
| object storage (backups) | Cloudflare R2 | Litestream target (control.db) | `$-` | zero egress |
| DNS | Cloudflare | buildexponential.org | `$-` | registrar + DNS |
| site hosting | Cloudflare Pages | static Eleventy build + `/apply` Pages Function | `$-` | free tier at launch |
| waitlist store | Cloudflare KV | `WAITLIST` namespace | `$-` | launch-phase `/apply` capture |

## Restore drill (release-checklist item)

A rehearsed restore drill must recover the bare repos + `control.db` onto a clean machine from object
storage. Not yet exercised on live infra - status tracked here when the stack deploys.
