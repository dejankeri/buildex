# First-launch runbook

A replayable walk through a new operator's first launch. Every step below has been **observed** on a
real boot - nothing here is written from intent. An agent with a browser driver can execute it top to
bottom; a human can too.

Design and rationale: `docs/superpowers/specs/2026-07-25-launch-walkthrough-design.md`.

> **Status:** in progress. Steps are added as they are verified. Missing steps are not "assumed
> passing" - they are unwalked.

## Environment

The walk runs against **this worktree's** demo environment, isolated from every other worktree.

Required variables, all three or none (`supabaseFromEnv` is all-or-nothing). Values are **not**
recorded here - keep them in an untracked `.env.local` at the repo root:

| Variable | What it is |
|---|---|
| `BUILDEX_SUPABASE_URL` | the Supabase project's public URL |
| `BUILDEX_SUPABASE_ANON_KEY` | the project's publishable/anon key (public by design) |
| `BUILDEX_SYNC_URL` | the hosted sync service base URL, where `POST /session` lives |

Absent any of them, `signIn` stays dormant and the workspace is local-only. That is a supported end
state, not a failure - but the cloud steps below cannot run.

**Use `demo:orgs:here`, not `demo:app:here`.** Only the multi-org daemon builds an account seam
(`wiring.ts` gates it on `orgId` + `orgDir`), so the single-workspace demo can never sign in - and it
is the mode that matches the shipped packaged app, which boots through `startOrgDaemon`.

## Reset

```sh
# 1. stop anything already running for this worktree
pkill -f "demo-here.ts"; pkill -f "electron apps/client"

# 2. find THIS worktree's demo dir (stable per worktree; never delete all of ~/.buildex-demo)
#    the launcher prints it on boot: "demoDir  /Users/<you>/.buildex-demo/<worktree>-<hash>"
rm -rf ~/.buildex-demo/<worktree>-<hash>

# 3. boot from zero, cloud-enabled
set -a && . ./.env.local && set +a && npm run demo:orgs:here
```

The demo dir and console port are derived from the worktree path, so the same worktree always gets
the same URL and two worktrees never collide.

---

## Step 1 - boot from zero

**Precondition:** demo dir absent, console port free.

**Action:** run the boot command in *Reset* above.

**Expected:**

| Observable | Expected |
|---|---|
| Console reachable | `GET /` → 200 within ~15s (first ever run downloads Electron; allow longer) |
| Launcher output | prints `worktree`, `console` URL, `gateway` port, `demoDir` |
| Agent detected | boot log names your `claude` CLI version |
| `GET /api/orgs` | 200, two orgs: a real active one, and `Acme Labs` with `sandbox: true` |
| `GET /api/sync` | `signInAvailable: true` |
| `unsaved` | `files: 3`, `connected: false` |
| Repos clean | `git status --porcelain` empty in `core`, `team`, `private` |

**On `unsaved: 3` — this is correct, not a defect.** With no account attached there is no upstream,
so *every* committed file in the operator's own roots counts as "the company's copy doesn't have this
yet": `team` (2 files) + `private` (1). `core` is the read-only pack and is excluded. The number
should go to 0 only after a save reaches a remote.

**Verify commands:**

```sh
curl -s http://127.0.0.1:<port>/api/sync
curl -s http://127.0.0.1:<port>/api/orgs
W=~/.buildex-demo/<worktree>-<hash>/orgs/<activeId>/workspace
for r in core team private; do git -C $W/$r status --porcelain; done   # all empty
```

**Known-good boot noise:** the connectors module logs `[connectors] authorize: https://…` lines for
Intercom/Linear/Notion at startup. Nothing is contacted - these are locally constructed PKCE URLs.

### Regressions this step has caught

- **Seed left `loops.yaml` uncommitted** (fixed 2026-07-25). The demo seeder wrote loops definitions
  into the team repo *after* committing it, so a first boot reported 1 unsaved file for work the
  operator never did, and the checkpoint net later wrote it into history as
  `~operator: update loops.yaml`. Guarded by `acme-seed.test.ts` - "leaves every seeded repo clean".
- **Sandbox mode cannot sign in.** `demo:app:here` reports `signInAvailable: false` no matter what
  the env holds, because the single-workspace daemon has no account seam. Use `demo:orgs:here`.

---

## Step 2 - the first-run wizard

**Precondition:** step 1 passed, `GET /api/onboarding` reports `firstRun: true`.

**Action:** open the console URL in a browser. The wizard opens by itself over the workspace.

There is **no** company-name dialog before it, and no setup-code form inside it. A workspace has
exactly two end states - signed in with Google, or fully local - and the wizard's last step is where
the operator picks.

**Expected, step by step:**

| # | Title | Expected |
|---|---|---|
| 1 | Welcome to BuildEx | states everything stays local until you choose to sync; CTA `Get started` |
| 2 | Connect your agent | detects Claude Code and names the version; skippable |
| 3 | Connect integrations | points at the ⊕ Store; skippable |
| 4 | You're all set | see below |

**The final step, signed out with sign-in wired:**

- Body says this is your **local** workspace, and offers the choice in one sentence: back it up, or
  keep everything on this device and decide later.
- **Exactly one primary button:** `Back up - sign in with Google`, full width.
- `Start using BuildEx` is a **ghost** button - it means "stay local", a real choice but not the
  recommended one. Two primaries here would leave the operator no signal which path to take.
- **No free-text inputs at all.** No "Company URL", no "Setup code".

**The final step, other states:**

| State | Expected |
|---|---|
| already connected | names the company, no backup button |
| sign-in dormant (`signInAvailable:false`) | "Everything stays on this machine", no button - a backup CTA would dead-end at a 501 |

**Verify commands:**

```sh
# advance to the last step and assert the shape
$B goto http://127.0.0.1:<port>
for i in 1 2 3; do $B click ".wz-primary"; done
$B js "!!document.querySelector('#wz-signin-google')"                       # → true
$B js "document.querySelectorAll('.wz-body input').length"                  # → 0
$B js "document.querySelectorAll('.wz-actions .wz-primary').length"         # → 0 (CTA is ghost)
$B screenshot /tmp/wizard-final.png
```

> **Timing:** the wizard is drawn after several `/api/*` round-trips. A snapshot taken immediately
> after `goto` can miss it - allow ~2-3s, or assert on `.wz-backdrop` existing rather than on a
> snapshot listing.

### Regressions this step has caught

- **The wizard asked for a "Company URL" and a "Setup code"** (fixed 2026-07-25) - two things a
  self-serve operator has never heard of and cannot supply. Replaced by the Google/local choice.
  Guarded by `console-render-account.test.ts` - "offers Google backup ... asks for no URL or code".
- **Two competing primary buttons** on the final step (fixed 2026-07-25).
