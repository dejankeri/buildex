# BuildEx - infrastructure living map

> **Cataloguing rule:** every infra change lands here - topology + cost ledger + snapshot date -
> in the same session it happens. **This repo is public: structure and placeholders only.**
> No real hosts, IDs, or costs.

**Snapshot date:** 2026-07-16 (deploy stack authored; nothing deployed yet).

## Deploy stack (authored, not yet live)

- `infra/compose.yml` - Docker Compose: **Caddy** (TLS reverse proxy, no stream timeouts) →
  **sync** service (`/srv/buildex/{control.db, repos}`) + **Litestream** sidecar. Secrets come from an
  untracked `infra/.env` (never committed).
- `infra/litestream.yml` - continuous `control.db` replication to object storage; `infra/Caddyfile`
  - automatic TLS + timeout-free proxy for long agent turns.
- **Backups:** Litestream (control.db, continuous) + restic (`/srv/buildex/repos`, hourly) → object
  storage. **Restore drill rehearsed** in code (`apps/sync` restore-drill: recovers control.db +
  repos onto a clean target and verifies) - the recovery logic is tested; the real object-storage
  transport runs on the VM.
- **Deploy:** `task deploy:plan` (dry-run) → `task deploy` (gated: dry-run first, then confirms).
- **Client release:** macOS ships a signed + notarized `.dmg` (`docs/guides/package-macos.md`);
  Windows ships an **unsigned** NSIS installer (`docs/guides/package-windows.md`) - there is no
  Authenticode certificate, so it trips SmartScreen. Both are hosted alongside a `latest.json`
  (`infra/latest.json.example` shape). Windows code-signing and auto-update remain fast-follows.
- **Restore command (clean VM):** `litestream restore -o /srv/buildex/control.db s3://<bucket>/control.db`,
  restic-restore the repos, then run the restore drill before serving traffic.

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
sync (one small VM, US region, Docker Compose)
  ├─ reverse proxy (TLS)
  ├─ BuildEx sync service (identity JWT · git smart-HTTP over bare repos · permission matrix
  │                     · core-pack publish · admin console)
  ├─ SQLite (WAL): /srv/buildex/control.db      ← Litestream (continuous) → object storage
  └─ bare repos:   /srv/buildex/repos           ← restic (hourly)          → object storage

client (Electron, per operator machine)
  └─ local daemon: agent driver · sync engine · connectors · policy/gate · map/history renderers
```

## Cost ledger

| Component | Provider | Sizing | Monthly (placeholder) | Notes |
|---|---|---|---|---|
| sync VM | _TBD_ | one small VM | `$-` | US region v1; region-portable |
| object storage (backups) | _TBD_ | Litestream + restic targets | `$-` | control.db + repos |
| DNS | Cloudflare | buildexponential.org | `$-` | registrar + DNS |
| site hosting | Cloudflare Pages | static Eleventy build + `/apply` Pages Function | `$-` | free tier at launch |
| waitlist store | Cloudflare KV | `WAITLIST` namespace | `$-` | launch-phase `/apply` capture |

## Restore drill (release-checklist item)

A rehearsed restore drill must recover the bare repos + `control.db` onto a clean VM from object
storage. Not yet exercised on live infra - status tracked here when the stack deploys.
