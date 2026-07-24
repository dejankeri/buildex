# BuildEx - operating rules (read this first)

**BuildEx** - the eXponential ORGanization Operating System: we wrap a coding agent + git +
connectors so seamlessly that a non-technical team can run their company on them. This file is the
operating contract for any agent (or human) working **in this monorepo**. Read it fully before
acting; it is the entry point, and a fresh session must be able to orient from it alone.

The repo dogfoods the product: it runs on BuildEx conventions from day one - capture-by-default,
living maps, and an allow/ask/deny policy (`.claude/`).

## What this repo is (and is not)

- **Two deployables + content**: `apps/client` (Electron desktop app + local daemon),
  `apps/sync` (the thin cloud service), plus `apps/{connectors,site,toolkit}` and `packs/core`
  (the product content shipped into every company's `core` repo).
- **Public under MIT.** No secret, credential, live infra value, or client-identifying detail ever
  enters this repo's history.
- Not a chat product, not a wiki, not RAG, not a cloud brain, not a model reseller.

## The 10 invariants (never weaken)

1. **Local-first** - the agent works on files on the operator's machine; the cloud syncs, never thinks.
2. **Git is the database** - every artifact is plain files; every change is checkpointed locally,
   and company history is deliberate, named saves (one meaningful snapshot per save); no shadow DB.
3. **Documents are plain markdown** - rendered views derived on demand, never committed.
4. **Conductor bright-lines** - never read any agent's credential store, never proxy model tokens,
   never set provider API keys, never render provider sign-in.
5. **Wide autonomy, few gates** - the agent acts autonomously by default across local files, web,
   and connected tools; a small, operator-configurable set of *money / outbound-to-people /
   irreversible* actions waits for a human tap, surfaced inline where the work is happening. Every
   gated action - approval, denial, outward send - is recorded on a company-level activity ledger;
   routine autonomous work is not logged (git history covers the files, the ledger covers the
   consequential moments).
6. **Hard company isolation** - per-company repos; server-side permission matrix; per-machine tokens.
7. **Identity from JWT only** - setup tokens minted S2S; loopback redirects validated; state one-time, short TTL.
8. **Never lose an operator's work** - unclean content is backed up locally and flagged, never discarded.
9. **Deterministic trust surfaces** - map/history/admin rendered from repo state with zero LLM.
10. **Build the seam, not the engine** - interfaces for deferred capabilities exist from day one.

## How work happens here

Every unit of work:

1. **Test-first at the seam** - every module lands with its hermetic suite (DI for fetch, git,
   keychain, agent spawn, clock); no network in unit lanes.
2. **Gate** - run `task ci` (secret-scan → test-collection-audit → typecheck → test) until green;
   the five invariant suites are release gates and cannot be skipped.
3. **Capture** - record every non-obvious decision (below). Learning accretes into the repo.

Humans sit at the edge: they approve at the gates and steer forks. Agents run everything between.

## Capture-by-default

Any non-obvious call - a new dependency, a resolved fork, a trade-off - is captured **in the same
session** it is made: in the PR description (for contributions) or the commit message, argued where
reviewers can see it. A decision that changes a settled call supersedes it visibly; never edit
history silently.

## Cataloguing rules

- **Infra**: every infra change lands in `infra/infrastructure.md` (topology + cost ledger +
  snapshot date) in the same session. No live hosts/IDs/costs in this public repo - the file
  carries structure and placeholders only.
- **Docs**: feature-based `docs/` - one guide per capability as capabilities land.

## Running the app across worktrees

The local app is driven by a demo env keyed on three globals - the demo dir (`~/.buildex-demo`),
the console port (`4317`), the gateway port (`4318`). To run several worktrees' apps at once,
use the per-worktree launchers instead of `npm run demo` / `demo:app`:

- `npm run demo:app:here` - native Electron app for **this** worktree
- `npm run demo:here` - browser/console only for **this** worktree

Each derives a **stable, non-colliding** demo dir (`~/.buildex-demo/<worktree>-<hash>`) and a
console/gateway port pair (4400 band, `console`=even, `gateway`=`console+1`) from the worktree
path - same worktree always gets the same URL, different worktrees never collide (a free-port
fallback covers the rare hash clash). The launcher prints the console URL / gateway port /
demoDir; reset one worktree with `rm -rf <that demoDir>`, never the whole `~/.buildex-demo`. Agents
should reach for the `run-worktree-app` skill. Derivation lives in
`apps/client/src/demo/worktree-env.ts`; gateway port override is `BUILDEX_DEMO_GATEWAY_PORT`.

## Ground rules

- **Public-quality from day one** - single MIT `LICENSE` over the whole monorepo; secret-scanning
  hook in CI; nothing sensitive in any file.
- **Serve the non-technical operator** - every client/UI/agent-driver/connector decision is judged
  by whether it serves the operator who runs the company, not a developer audience.
- **Package manager: npm** (workspaces, hoisted to root). **Stack**: TypeScript + Vitest;
  `apps/client` is Electron.
