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

### Local only

Use this between runs that do not involve the cloud.

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

### Full reset - server and client

Needed whenever a run reached the cloud, because the local wipe above leaves the company standing on
the sync service. Sign in again without this and the **same email lands on `<slug>-2`**: `dedupeSlug`
suffixes while the old row holds the name.

```sh
# 1. delete the company on the server - IRREVERSIBLE, there is no second copy of a team/private repo
export BUILDEX_SERVICE_KEY=...                       # never pass it as an argument
task delete-company -- --base-url https://<host> --slug <slug>

# 2. then the local reset above (stop, rm the demo dir, boot)
```

Then confirm the clean state before starting a run:

| Endpoint | Expected |
|---|---|
| `GET /api/account` | `{"state":"local"}` |
| `GET /api/onboarding` | `firstRun: true` |
| `GET /api/sync` | `signInAvailable: true`, `unsaved.connected: false` |

**Do not use `/s2s/revoke` for this.** It only drops grants. `findOperatorBySupabaseSub` does not
filter on status, so the operator is still resolved by `sub` and the next sign-in mints working
tokens for a principal with no permissions - a credential that authenticates and can touch nothing.
`task delete-company` is the only path that actually starts over.

**The Supabase auth user is deliberately left alone.** Deletion keys on the operator row, so the same
Google account provisions a fresh company next time. Nothing to clean there.

### Connector credentials survive `rm -rf` - clear them too

**`rm -rf <demoDir>` is not a clean slate for anything connector-shaped.** The keychain service is
`buildex-<sha256(workspace path)[:12]>` (`keychain.ts:keychainService`), so whether a wipe orphans the
old namespace depends entirely on whether that path is stable:

| Mode | Workspace path | Survives a wipe? |
|---|---|---|
| a real signed-in org | `…/orgs/<randomUUID[:8]>/workspace` | no - new org, new namespace |
| **the demo org** (`demo:orgs:here`) | `…/orgs/demo/workspace` | **yes** - `DEMO_ORG_ID` is the literal `"demo"` |
| **`demo:here`** | `…/<worktree>-<hash>/workspace` | **yes** - derived from the worktree path |

Both modes you actually test in reuse the namespace. What survives: `connectors-mcp:specs` (the
persisted provider list, which is the **trust root** for reconnect-on-restart - deliberately not
re-read from the workspace, so a repo edit cannot silently repoint a connected provider at another
server) and every `connector:<name>:oauth:*` slot.

Two consequences, both of which will waste your afternoon:

- A connector stays **connected** across a full wipe. Convenient when you want it; misleading when
  you are testing first-run.
- Changing a pack's `mcp.url` has **no effect** on an already-registered provider. The gateway keeps
  using the persisted spec.

```sh
SVC=buildex-$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,12))" "$HOME/.buildex-demo/<worktree>-<hash>/workspace")
security delete-generic-password -s "$SVC" -a "connectors-mcp:specs"
for slot in client tokens verifier state; do
  security delete-generic-password -s "$SVC" -a "connector:<pack>:oauth:$slot" 2>/dev/null
done
```

**No `curl` inside the sync machine.** The Alpine runtime ships `git`, `git-daemon` and `litestream`
only. To poke the API from inside the box, use `node -e` with global `fetch`; for the control DB use
`node --experimental-sqlite` (there is no `sqlite3` binary either). Running from inside is the way to
use `BUILDEX_SERVICE_KEY` without it leaving the machine.

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

---

## Step 2b - backing up (Google sign-in)

The one step that **cannot** be driven headlessly: it opens the operator's real browser and needs a
human at the Google consent screen. Everything up to the redirect is assertable; the round-trip is not.

**Precondition:** signed out, `signInAvailable: true`, nothing already listening on port `54121`.

**Action:** click `Back up - sign in with Google` (wizard final step), the left-rail
`Back up & sync` pill, or the title-bar sync dot while it reads local. Complete Google in the browser.

**Expected:**

| Stage | Observable |
|---|---|
| button label | `Signing in…` for the whole wait - it covers the browser leg **and** the backup behind it |
| browser lands on | `http://127.0.0.1:54121/auth/callback?code=<uuid>&state=<ours>` - **both** params present |
| callback page | "Signed in - you can close this tab and return to BuildEx" |
| wait | seconds, not instant: machine token, attach three roots, push two repos over HTTPS |
| wizard final step | "Your work is backed up **to `<company>`**" - the company must be named |
| left-rail pill | gone |
| sync dot | `sync ok`, title "Synced · click for recent changes" |
| profile menu | "Connected to `<company>`" + "Log out"; no "Sign in" |

**Verify commands:**

```sh
curl -s http://127.0.0.1:<port>/api/account   # state connected, companySlug, three remotes
curl -s http://127.0.0.1:<port>/api/sync      # unsaved.files 0, connected true
W=~/.buildex-demo/<worktree>-<hash>/orgs/<activeId>/workspace
for r in core team private; do
  git -C $W/$r rev-parse --verify --quiet refs/remotes/origin/main >/dev/null && echo "$r pushed" || echo "$r NOT pushed"
done
```

**`core` must report NOT pushed.** It is the read-only pack and the sync service rejects pushes to it
with 403 by design. `team` and `private` must both be pushed. Reading a missing `origin/main` on
`core` as a failure is the trap here.

### Regressions this step has caught

- **`sign-in was denied: invalid_request`** after a successful Google authorization (fixed
  2026-07-25). The client sent its own `state` to `/auth/v1/authorize`, but GoTrue owns that
  parameter - it mints a UUID, keys the flow on it, and forwards it to the provider. Ours got
  forwarded instead, so GoTrue's callback found no matching flow. Our one-time state now rides in
  `redirect_to`'s query. Guarded by `real-seams.test.ts`.
- **"Opening Google…" shown for the whole wait** (fixed 2026-07-25) - Google finishes in seconds;
  the rest is the backup, and naming the finished step reads as a hang.
- **"Your work is backed up." with no company name** (fixed 2026-07-25). `POST /api/signin` returns
  `{state}` only; the slug is on `GET /api/account`. The jsdom test missed this because its fake
  returned a `companySlug` the real endpoint never sends - **when writing a fake, copy the real
  handler's response shape, not the one you assume.**

---

## Step 3 - the quick tour

Runs automatically once the wizard finishes (`finish()` calls `startTour(true)`), and is replayable
any time from the title-bar **?** button.

**Action:** finish the wizard, or click **?**. Advance with **Next**, **→**/**Enter**; **Esc** or
**Skip** exits.

**Expected:** six steps, each spotlighting a region that exists, in this order:

| # | Title | Anchors to |
|---|---|---|
| 1 | The left panel | `.left` |
| 2 | Start a session | `#newProject` (or `#newSessionTop`) |
| 3 | Open different screens | `#tabAdd` |
| 4 | The right panel | `#rtabs` — must name **Brain**, **Documents**, **Loops** |
| 5 | Your apps & tools | `.apps-hd` (or `#storeTop`) |
| 6 | Your company brain | `#brandBtn` |

On finish: the card and `.tour-back` backdrop are both removed, `localStorage` holds
`buildex.tour.v2 = 1`, and the console logs no errors.

> **`collectTourSteps()` silently drops any step whose anchor is missing.** That is what keeps the
> tour from breaking when the UI moves - and it means a renamed region makes its step vanish with no
> error at all. Always check the count reads **"Step 1 of 6"**, not just that the tour runs.

**Verify commands:**

```sh
$B js "(function(){var b=document.querySelector('.wz-backdrop'); if(b) b.remove(); startTour(true); return 'ok';})()"
$B js "document.querySelector('.tour-card').textContent"     # → "Step 1 of 6 …"
for i in 1 2 3; do $B js "tourGo(1)"; done
$B js "document.querySelector('.tour-card').textContent"     # → step 4, naming Brain/Documents/Loops
```

### Regressions this step has caught

- **The right-panel step described a rail that no longer exists** (fixed 2026-07-25): "switch it
  between Pending approvals, Files, and Skills", long after that rail became Brain / Documents /
  Loops and approvals moved onto the Brain icon's badge. Nothing failed - the step's anchor still
  existed, so it rendered confidently wrong copy. `tour.js` had no tests at all; it has
  `console-tour.test.ts` now, which reads the panel names out of the real `index.html` so the test
  fails when the UI moves rather than when a fixture goes stale.
- `TOUR_FLAG` was bumped to `v2` so anyone who saw the wrong tour gets the corrected one once.

---

## Step 4 - install an app from the Store

The Store is how a company gains a capability. This step uses **Protocol** (a coaching CRM) because
it is the only pack that exercises all three faces at once - an MCP tool surface, a skills pack, and
an API-key fallback - but the shape holds for any pack.

**Do:** open the Store (`⊕ Store` in the left rail), find the app, click **Install**.

| Check | Expected |
|---|---|
| The card | Badges naming the faces it brings. Protocol: `APP` · `TOOLS` · `KEY` · `SKILLS ×9` |
| On clicking Install | A confirmation - *"This adds X to your apps, and files its skills and rules in the team brain for everyone."* Nothing is written until you approve. |
| After **Approve & install** | The card reads **✓ Installed**; the app appears in the left rail |
| Right rail | **Rules & Skills** count rises by the pack's skill count |

**Where the pieces land** (verify on disk, not just in the UI):

```sh
W=~/.buildex-demo/<worktree>-<hash>/workspace
find $W -path "*skills/protocol-*" -name SKILL.md | sed "s|$W/||"   # → team-acme/skills/… (COMPANY, not private)
ls $W/private-you/policy/packs/protocol.json                        # → the per-operator install marker
ls $W/team-acme/policy/packs/protocol.json                          # → the company rule
```

The split is the model, not an accident: the **app face is yours**, the **skills and policy are the
company's**. A teammate who never installed it still gets the rules.

### Regressions this step has caught

- **The install gate is real and it blocks.** `POST /api/catalog/install` does not return until a
  human approves in the Pending tray (`daemon.ts` → `broker.request`), so no loopback caller - the
  agent included - can install anything on its own (invariant 5). Scripted runs must approve the
  card, or the request hangs forever. It is not a stall; it is the gate.
- **A malformed URL in ONE optional face removes the whole app from the Store, silently.**
  `parsePack` returns `undefined` for the entire manifest when `validProvision` fails, and
  `validProvision` requires `https://` on `authorizeUrl` / `exchangeUrl` / `docsUrl`. Point
  `provision.exchangeUrl` at `http://localhost` for a local test and Protocol simply vanishes from
  the catalog - no error, no log line, no card. If an app is missing from the Store, suspect its
  manifest before anything else:
  ```sh
  curl -s http://127.0.0.1:<console>/api/catalog | python3 -c "import sys,json;print([p['id'] for p in json.load(sys.stdin)['packs']])"
  ```

---

## Step 5 - authorize the app's MCP connection

Installing gives you the app; authorizing gives the agent its tools. For a remote MCP pack these are
deliberately separate acts.

**Two paths, and which one a pack takes is decided by its manifest:**

| Path | When | Where the credential lives |
|---|---|---|
| **Gateway OAuth (DCR)** | `mcp.kind: "http"` and no `direct: true` - the default | Keychain, proxied over loopback. Tools reach the agent as `<pack>__<tool>` through the gateway; there is **no** `buildex-pack:*` pin in `.mcp.json` |
| **API key** | the operator saves a key (`apiKey.transport: "mcp-bearer"`) | Keychain; the pack is direct-pinned in `.mcp.json` with a Bearer header. **Overrides OAuth** (`installedPackMcpEntries`) |

**Do:** click the app's connect control and complete the provider's consent screen.

| Check | Expected |
|---|---|
| `GET /api/connectors/gateway` | the pack listed, `needsAuth: true`, a real `authUrl` |
| The consent screen | names **the BuildEx client** and the **loopback redirect host**, not something generic |
| After approving | `connected: true`, `tools: <n>`, and the left-rail app shows a green dot |
| Right rail | **Tools** count rises by `<n>` |
| `.mcp.json` | still only `buildex-connectors` - a gateway-routed pack is **not** directly pinned |

**Reconnect survives a restart.** The provider spec and tokens are keychain-persisted, so a restart
(even after `rm -rf <demoDir>`) comes back **connected** with no second consent. That is the intended
trust-root behaviour - see the keychain note in **Reset**, and clear those entries when you actually
want to re-test first-connect.

### Regressions this step has caught

- **The gateway validates the OAuth resource indicator, and it is right to.** If the MCP server's
  `/.well-known/oauth-protected-resource/mcp` advertises a `resource` that does not match the URL
  being connected, the connect fails with
  `Protected resource <advertised> does not match expected <configured>`. Pointing a pack at a local
  server without also setting that server's public base URL trips this. Diagnose with:
  ```sh
  curl -s <mcp-base>/.well-known/oauth-protected-resource/mcp   # `resource` must equal the pack's mcp.url
  ```
- **Changing a pack's `mcp.url` does not move an already-connected provider** - the keychain spec
  wins. Clear `connectors-mcp:specs` first (see **Reset**) or you will spend an hour reading a URL
  the gateway is not using.

---

## Step 6 - the agent does real work through the app

This is the step that matters: the operator asks for an outcome in their own words and the agent
uses the installed app's tools to produce it. Everything before this is plumbing.

**Do:** open a session and ask for something that requires the app. Real example used here, against a
copy of a live coaching account:

> "Build <client> a new nutrition plan in Protocol for his next block - he is cutting. Ground it in
> his actual profile and what he already eats, and assign it to him. Tell me the calories and macros
> you landed on when you are done."

| Check | Expected |
|---|---|
| Tool use | reads before it writes - a client review first, then the write |
| The artifact | actually exists in the third-party system, with the right owner |
| The numbers | grounded in that client's real data, not invented |
| The report back | in the operator's language, and **honest about anything that failed** |

**Judge the output as the end customer would**, not as a passing test. Round, coachable quantities.
Foods the client already eats. A calorie target that sits near what they were already doing, if their
history says consistency is the constraint. A plan that hits a macro target exactly using 2.61
fillets is a failed run even though every call returned 200.

### Regressions this step has caught

These were found by running exactly this prompt once, and they are the reason the step exists.

- **A malformed write deleted a live client's active 5-week program, and reported success.**
  `build_program` published `phases: { type: 'object' }` with no properties, so the agent could not
  know each row needs an `add` / `ref` / `modify` control key. `reconcileTree` rejected every row,
  returned an empty list, and `set_program_phases` saved it over the program. Fixed upstream in
  Protocol: the grammar is published on the verb, and `isDestructiveTotalFailure` now refuses any
  all-rejected replace over existing content. **Re-test by sending a phase list with no control
  keys - the write must be refused and the existing phases must survive.**
- **The same shape in `build_nutrition` created empty plans and duplicate rows.** All rows silently
  dropped, `isError` unset, so the agent retried - one plan existed **85 times** for a single client
  in the production copy. The verb now fails loudly and hands back the empty template's id with an
  instruction to reuse it rather than create another.
- **Trust the agent's escalation, then verify it.** The agent correctly reported the program wipe
  rather than hiding it - but its other claim ("`build_nutrition`'s `userId` is broken") was an
  artifact of a **stale test database missing migrations**, not a product bug. Apply the migration
  folder to any prod copy before believing a schema-shaped failure:
  ```sh
  cd apps/api && for f in $(ls migrations/V*.sql | sort); do psql … -f "$f"; done   # idempotent by rule
  ```

### Judging the numbers

Nothing here is checkable by assertion; a human reads it. What "good" looked like on the reference
run: ~2290 kcal, 180 g protein, 209 g carbs, 80 g fat for a cutting block - protein high to hold
lean mass, total deliberately close to the client's own previous fat-loss block because their profile
flags consistency (not ambition) as the limiting factor. Built from the client's established staples
rather than an invented menu.
