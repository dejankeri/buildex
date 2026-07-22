# Sync Close-Out Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three real gaps that stand between the sync client and "fully done, no gaps": a second-machine attach test, a revoked-token status that says *reconnect* instead of looking like a network blip, and a permanent place to connect an account after first-run.

**Architecture:** Three independent changes to existing seams. Task 1 is test-only (defends `attachOrg`'s non-empty-upstream path). Task 2 threads a new `AuthRotation` union + `AuthRevokedError` from the token provider through the engine so `receive`/`publish` map a revoked account to `needs-help`. Task 3 extracts a standalone connect modal and wires it to the always-visible title-bar sync dot.

**Tech Stack:** TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Vitest, real git via `execFile`; the web console is plain classic-script browser JS (NO ES modules), tested in jsdom via `console-harness.ts`.

## Global Constraints

- Machine token NEVER on disk, in a remote URL, in `.git/config`, in argv, or in a commit — only as a `GIT_CONFIG_*` `http.extraHeader`. These tasks touch none of that; do not regress it.
- Never lose an operator's work (invariant 8): a status change must never discard or hard-reset uncommitted work. A revoked-token `needs-help` is a *status only* — it must NOT write `.sync-needs-help` or run `backupAndReset` (those belong to the rebase-conflict path alone).
- Operator-facing copy only: never surface `push`/`commit`/`branch`/`merge`/`diff`/`token`. The field is a "Setup code", the action is "Connect", the destination is "your company".
- The web console is classic scripts sharing one global scope — NO `import`/`export`, NO ES modules. New top-level `function name()` declarations become globals (and the jsdom harness auto-exposes them).
- Tests are hermetic: no network. Git tests use `file://` bares. `apps/client` runs Vitest with a 30s timeout for real-git tests — run them via `npm run test --workspace @buildex/client`.
- Keep `apps/client` typechecking clean under `noUncheckedIndexedAccess` (`npm run typecheck --workspace @buildex/client`).

---

### Task 1: Attach-level non-empty-upstream test (second-machine path)

**Files:**
- Test: `apps/client/src/account/attach.test.ts` (add one `it` to the existing `describe("attachOrg", …)`)

**Interfaces:**
- Consumes: `attachOrg({ engine, roots, repos, sandbox })` from `./attach.js`; `SyncEngine` from `../sync/engine.js`. Existing helpers already in the file: `bare(name)`, `localRoot(name, seedFile)`, `engine()`, `repos()`, `git(args, cwd)`, and the `root` temp dir from `beforeEach`.
- Produces: nothing (test-only).

**Why:** Today the real second-machine case — a teammate's commit already sits on the `team` remote, then this laptop attaches and must rebase its own local work on top — is only exercised inside `engine.test.ts`, never *through* `attachOrg`'s wiring. This test pins that path. It should pass against the current `attach.ts` (attach → `receive` rebases → `publish` pushes).

- [ ] **Step 1: Write the test** (append inside the existing `describe`, before its closing `});`)

```ts
  it("rebases local work on top of a teammate's existing upstream, then pushes both up (second operator)", async () => {
    const r = repos();

    // A teammate already pushed to the team remote. Seed it by cloning the bare, committing, pushing.
    const seed = join(root, "seed");
    git(["clone", r.team.replace("file://", ""), seed], root);
    writeFileSync(join(seed, "teammate.md"), "from teammate\n");
    git(["add", "-A"], seed); git(["commit", "-m", "teammate work"], seed);
    git(["push", "origin", "HEAD:main"], seed);

    // This laptop has its OWN local team work that never touched the remote.
    const roots = [
      { name: "core", dir: localRoot("core", "c.md") },
      { name: "team", dir: localRoot("team", "mine.md") },
      { name: "private", dir: localRoot("private", "p.md") },
    ];

    const res = await attachOrg({ engine: engine(), roots, repos: r, sandbox: false });
    expect(res.status).toBe("connected");

    // Local now contains BOTH the teammate's file (rebased under it) and its own file (rebased on top).
    const teamDir = roots[1]!.dir;
    expect(existsSync(join(teamDir, "teammate.md"))).toBe(true); // upstream work was taken in
    expect(existsSync(join(teamDir, "mine.md"))).toBe(true);     // local work was preserved (invariant 8)

    // The remote received the local commit on top of the teammate's - nothing was lost either way.
    const log = git(["log", "--oneline", "origin/main"], teamDir);
    expect(log).toContain("teammate work");
    const remoteHead = git(["ls-remote", r.team.replace("file://", ""), "refs/heads/main"], root);
    const localHead = git(["rev-parse", "HEAD"], teamDir).trim();
    expect(remoteHead).toContain(localHead); // local HEAD is what the remote now points at
  });
```

- [ ] **Step 2: Ensure the imports the test needs are present**

The file already imports `writeFileSync, mkdirSync` from `node:fs`. Add `existsSync` to that same import if it is not already there:

```ts
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
```

- [ ] **Step 3: Run the test — it must PASS against current attach.ts**

Run: `npm run test --workspace @buildex/client -- --run src/account/attach.test.ts`
Expected: PASS (all attach tests, including the new one).

- [ ] **Step 4: Prove it has teeth**

Temporarily change the new test's teammate seed to push NOTHING (comment out the `git push` in Step 1) and confirm the `expect(...teammate.md...).toBe(true)` assertion still holds only when the upstream is genuinely non-empty — then restore. (Controller RED-verifies separately; you need only confirm the test passes as written.)

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/account/attach.test.ts
git commit -m "test(account): attach rebases local work onto a non-empty upstream (second machine)"
```

---

### Task 2: A revoked token surfaces as needs-help, not a network blip

**Files:**
- Modify: `apps/client/src/sync/engine.ts` (add `AuthRotation` type + `AuthRevokedError`; change `EngineAuth.onAuthError` return; branch in `git()`; map in `receive`/`publish`)
- Modify: `apps/client/src/account/token-provider.ts` (`rotate()` returns `AuthRotation`, classifies 401/403 as revoked)
- Test: `apps/client/src/sync/engine.test.ts` (revoked → needs-help mapping)
- Test: `apps/client/src/account/token-provider.test.ts` (update boolean → union; add revoked/offline cases)

**Interfaces:**
- Consumes: `ProvisionError` (has `.status: number`) and `refresh` from `./provision-client.js`; `AccountStore` from `./account-store.js`.
- Produces:
  - `export type AuthRotation = "rotated" | "revoked" | "offline"` (in `engine.ts`)
  - `export class AuthRevokedError extends Error` (in `engine.ts`)
  - `EngineAuth.onAuthError(): Promise<AuthRotation>` (was `Promise<boolean>`)
  - `TokenProvider.rotate(): Promise<AuthRotation>` (was `Promise<boolean>`)

**Why:** When a token is revoked, `engine.git()`'s rotate fails, `receive` catches it as `"offline"` and `publish` as `"queued"` — so a dead account looks like a transient hiccup and backoff-retries forever with no reconnect nudge. The spec's error table says a revoked account is `needs-help`. We distinguish the two at the source: a `401/403` from `/token/refresh` means the refresh token itself is rejected (revoked); anything else (network, 5xx) is transient.

- [ ] **Step 1: Write the failing engine test** (add to `apps/client/src/sync/engine.test.ts`)

Add these imports at the top if absent: `AuthRevokedError` is not needed in the test; only `SyncEngine` and an `AuthRotation`-typed stub. Add a helper and two tests inside the file's top-level `describe` (or a new `describe`):

```ts
import type { AuthRotation } from "./engine.js";

// A repo with a remote that git can NEVER reach, so every fetch/push fails - lets us drive the
// engine's auth-classification branch without a network. classifyAuthError:()=>true treats that
// failure as an auth rejection, so onAuthError() is consulted and its outcome decides the result.
function repoWithUnreachableRemote(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", "."], { cwd: dir, env: ENV });
  writeFileSync(join(dir, "doc.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: dir, env: ENV });
  execFileSync("git", ["remote", "add", "origin", "file://" + join(root, "does-not-exist.git")], { cwd: dir, env: ENV });
  return dir;
}
function engineWithAuth(outcome: AuthRotation): SyncEngine {
  return new SyncEngine({
    now: Date.now,
    actor: "t",
    classifyAuthError: () => true,
    auth: { headerEnv: () => undefined, onAuthError: async () => outcome },
  });
}

describe("engine auth: revoked vs transient", () => {
  it("receive() reports needs-help (reconnect) when the account is revoked, not offline", async () => {
    const dir = repoWithUnreachableRemote(root, "revk");
    expect(await engineWithAuth("revoked").receive(dir)).toBe("needs-help");
  });
  it("receive() stays offline (retryable) when the failure is transient", async () => {
    const dir = repoWithUnreachableRemote(root, "trans");
    expect(await engineWithAuth("offline").receive(dir)).toBe("offline");
  });
  it("publish() reports needs-help for a revoked account instead of queued", async () => {
    const dir = repoWithUnreachableRemote(root, "pubrevk");
    expect(await engineWithAuth("revoked").publish(dir)).toBe("needs-help");
  });
  it("publish() stays queued (work safe locally, retryable) when the failure is transient", async () => {
    const dir = repoWithUnreachableRemote(root, "pubtrans");
    expect(await engineWithAuth("offline").publish(dir)).toBe("queued");
  });
});
```

Note: `engine.test.ts` already imports `execFileSync`, `mkdirSync`, `writeFileSync`, `join`, and defines `ENV` and a `root` temp dir in `beforeEach`. If any of these names differ in the file, adapt to the file's existing helpers rather than redefining them (do not duplicate an `ENV`/`root` already declared).

- [ ] **Step 2: Run the new engine tests — they must FAIL**

Run: `npm run test --workspace @buildex/client -- --run src/sync/engine.test.ts -t "revoked vs transient"`
Expected: FAIL — today `receive` returns `"offline"` and `publish` returns `"queued"` for both outcomes (there is no revoked path yet), and `onAuthError` is typed `Promise<boolean>` so `async () => "revoked"` will not compile until Step 3.

- [ ] **Step 3: Implement the engine changes** in `apps/client/src/sync/engine.ts`

Add near the top, after the existing `ReceiveResult` type:

```ts
/** Outcome of an auth-rotation attempt, returned by EngineAuth.onAuthError():
 *  - "rotated": a fresh token is stored - retry the git op once.
 *  - "revoked": the refresh token itself was rejected (401/403) - the account is dead, not a
 *    transient blip, so the engine throws AuthRevokedError and receive/publish surface needs-help.
 *  - "offline": rotation could not reach the server - transient; the original error propagates and
 *    the caller treats it as offline/queued and retries on the next tick. */
export type AuthRotation = "rotated" | "revoked" | "offline";

/** A push/fetch failed auth AND the refresh token was rejected - the account must be reconnected.
 *  Distinct from a transient network failure so the scheduler surfaces `needs-help` (reconnect)
 *  rather than `offline`/`queued` (will retry on its own). Carries NO conflict semantics: it never
 *  triggers a backup or hard-reset - the operator's work simply stays local until they reconnect. */
export class AuthRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRevokedError";
  }
}
```

Change the `EngineAuth` interface's `onAuthError`:

```ts
export interface EngineAuth {
  /** gitAuthEnv(currentToken), or undefined when there is no account yet (local-only). */
  headerEnv(): Record<string, string> | undefined;
  /** Rotate after an auth-classified failure. See AuthRotation for what each outcome means. */
  onAuthError(): Promise<AuthRotation>;
}
```

Change the `git()` catch block's rotate branch. Replace the existing:

```ts
      if (this.deps.auth && classify(String(stderr)) && (await this.deps.auth.onAuthError())) {
        return (await run()).stdout; // retry once with the rotated header (headerEnv re-read above)
      }
      throw e;
```

with:

```ts
      if (this.deps.auth && classify(String(stderr))) {
        const outcome = await this.deps.auth.onAuthError();
        if (outcome === "rotated") return (await run()).stdout; // retry once with the rotated header
        if (outcome === "revoked") throw new AuthRevokedError(String(stderr)); // account dead → needs-help
        // "offline": rotation couldn't reach the server - fall through and propagate the original
        // error so the caller treats it as a transient offline/queued failure and retries later.
      }
      throw e;
```

In `receive()`, change the fetch catch:

```ts
    try {
      await this.git(["fetch", "origin"], dir);
    } catch (e) {
      if (e instanceof AuthRevokedError) return "needs-help"; // revoked - reconnect, don't spin
      return "offline";
    }
```

In `publish()`, change the push catch:

```ts
    try {
      await this.git(["push", "origin", "HEAD:main"], dir);
    } catch (e) {
      if (e instanceof AuthRevokedError) return "needs-help"; // revoked - reconnect, don't spin
      return "queued";
    }
```

- [ ] **Step 4: Run the engine tests — they must PASS**

Run: `npm run test --workspace @buildex/client -- --run src/sync/engine.test.ts`
Expected: PASS (the four new tests + all existing engine tests).

- [ ] **Step 5: Update the token provider** in `apps/client/src/account/token-provider.ts`

Change the import to also bring in `ProvisionError`, and import the `AuthRotation` type from the engine:

```ts
import type { AccountStore } from "./account-store.js";
import { refresh, ProvisionError } from "./provision-client.js";
import type { AuthRotation } from "../sync/engine.js";
```

Change the `TokenProvider` interface and `rotate()`:

```ts
export interface TokenProvider {
  current(): string | undefined;
  rotate(): Promise<AuthRotation>;
}
```

```ts
    async rotate(): Promise<AuthRotation> {
      const account = deps.store.load();
      const tokens = deps.store.tokens();
      if (!account || !tokens) return "offline"; // nothing to rotate - not a revocation, never wipe
      try {
        const rotated = await refresh({ fetch: deps.fetch, baseUrl: account.baseUrl }, tokens.refreshToken);
        deps.store.setTokens({ machineToken: rotated.machineToken, refreshToken: rotated.refreshToken });
        return "rotated";
      } catch (e) {
        // A 401/403 from /token/refresh means the refresh token itself is rejected - the account is
        // revoked and must be reconnected. Anything else (network = status 0, 5xx) is transient.
        // Either way the stored pair is left untouched: the account is never silently wiped.
        if (e instanceof ProvisionError && (e.status === 401 || e.status === 403)) return "revoked";
        return "offline";
      }
    },
```

Update the file's top comment's last sentence so it no longer says `rotate` returns a boolean/`needs-help` — describe the three outcomes instead.

- [ ] **Step 6: Update `token-provider.test.ts`** for the new return type

Replace the three `rotate()` assertions:
- `expect(await tp.rotate()).toBe(true);` → `expect(await tp.rotate()).toBe("rotated");`
- The `401` test (`fetchWith(401, { error: "revoked" })`): `expect(await tp.rotate()).toBe(false);` → `expect(await tp.rotate()).toBe("revoked");` and update the test name to say "revoked" instead of "returns false".
- The no-account test: `expect(await tp.rotate()).toBe(false);` → `expect(await tp.rotate()).toBe("offline");`

Add two cases:

```ts
  it("rotate() reports offline (transient) when the refresh cannot reach the server", async () => {
    const s = store();
    const throwing = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const tp = makeTokenProvider({ store: s, fetch: throwing });
    expect(await tp.rotate()).toBe("offline"); // network failure is NOT a revocation
    expect(tp.current()).toBe("xmachine_old"); // pair left in place
  });

  it("rotate() reports offline (transient), not revoked, on a 5xx", async () => {
    const s = store();
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(503, { error: "down" }) });
    expect(await tp.rotate()).toBe("offline");
    expect(tp.current()).toBe("xmachine_old");
  });
```

- [ ] **Step 7: Run the provider tests + typecheck**

Run: `npm run test --workspace @buildex/client -- --run src/account/token-provider.test.ts`
Expected: PASS.
Run: `npm run typecheck --workspace @buildex/client`
Expected: clean (0 errors). The `wiring.ts` adapter `onAuthError: () => tokenProvider.rotate()` now returns `Promise<AuthRotation>` and matches `EngineAuth` structurally — no change should be needed there; if tsc reports a mismatch, fix the wiring adapter's types, do not widen `AuthRotation`.

- [ ] **Step 8: Commit**

```bash
git add apps/client/src/sync/engine.ts apps/client/src/sync/engine.test.ts apps/client/src/account/token-provider.ts apps/client/src/account/token-provider.test.ts
git commit -m "feat(sync): a revoked account says reconnect (needs-help), not offline/queued"
```

---

### Task 3: A permanent place to connect an account (title-bar sync dot)

**Files:**
- Create: `apps/client/web/js/account.js` (standalone `openConnectAccount()` modal)
- Modify: `apps/client/web/index.html` (add `<script src="js/account.js">` in load order, right after `js/onboarding.js`)
- Modify: `apps/client/web/js/boot.js` (dot click opens the connect modal when the workspace is local/unconnected)
- Modify: `apps/client/web/js/sync.js` (local tooltip copy: "click to connect an account")
- Test: `apps/client/src/console-connect-account.test.ts` (new; jsdom via `console-harness.ts`)

**Interfaces:**
- Consumes globals already in the bundle: `elt(tag, cls)`, `esc(s)`, `postJSON(url, body)`, `getJSON(url)`, `refreshProjects()`, `$(sel)`. The dot element is `#sync`; its state classes include `local` (set by `setSync` in `sync.js`, decided by `syncDotState` in `projects.js`).
- Produces: a top-level `function openConnectAccount()` (becomes a global; the jsdom harness auto-exposes it on `c`).

**Why:** The connect affordance today lives ONLY on the first-run wizard's final step. An operator who skipped onboarding, or upgraded an existing install, has no way to paste a setup code later — the whole account seam is unreachable for them. The always-visible title-bar sync dot already reads `local` when there is no account; clicking it there should open a connect dialog. This reuses onboarding's proven POST `/api/account` → `refreshProjects()` flow.

- [ ] **Step 1: Write the failing console test** — `apps/client/src/console-connect-account.test.ts`

```ts
// Browser test net for the standalone "connect an account" surface: the title-bar sync dot, when the
// workspace is local (no account), opens a connect modal that POSTs /api/account - the same flow the
// onboarding wizard uses, now reachable AFTER first-run. Loads the REAL bundle into jsdom (see
// console-harness.ts) and routes fetch to controlled JSON, per console-render-account.test.ts.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

describe("console (jsdom) — connect an account after first-run", () => {
  it("openConnectAccount() builds a modal with a Company URL + Setup code field", () => {
    const { doc, c } = loadConsole();
    c.openConnectAccount();
    const card = doc.querySelector(".wz-card, .connect-card");
    expect(card).not.toBeNull();
    expect(doc.querySelector("#wz-baseurl")).not.toBeNull();
    expect(doc.querySelector("#wz-code")).not.toBeNull();
    expect(doc.querySelector("#wz-connect")).not.toBeNull();
    // operator copy only - no engineer jargon leaks into the dialog
    expect(doc.body.textContent).not.toMatch(/\b(push|commit|branch|merge|diff|token)\b/i);
  });

  it("POSTs {baseUrl, setupToken} on Connect and closes the modal once connected", async () => {
    const { doc, w, c } = loadConsole();
    let posted: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/account") && opts && opts.method === "POST") {
        posted = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: "connected", companySlug: "acme" }) });
      }
      if (u.includes("/api/projects")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ projects: [{ id: "p1", name: "Workspace", items: [] }] }) });
      if (u.includes("/api/sessions")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [] }) });
      if (u.includes("/api/sync")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: true } }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    c.openConnectAccount();
    (doc.querySelector("#wz-baseurl") as unknown as { value: string }).value = "https://sync.acme.dev";
    (doc.querySelector("#wz-code") as unknown as { value: string }).value = "setup_abc123";
    (doc.querySelector("#wz-connect") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual({ baseUrl: "https://sync.acme.dev", setupToken: "setup_abc123" });
    expect(doc.querySelector("#wz-connect")).toBeNull(); // modal torn down on success
  });

  it("shows the returned error inline on a 4xx and leaves the form up to retry", async () => {
    const { doc, w, c } = loadConsole();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (w as any).fetch = (url: string, opts: any) => {
      const u = String(url);
      if (u.includes("/api/account") && opts && opts.method === "POST") {
        return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: "That setup code was not recognized." }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    c.openConnectAccount();
    (doc.querySelector("#wz-baseurl") as unknown as { value: string }).value = "https://sync.acme.dev";
    (doc.querySelector("#wz-code") as unknown as { value: string }).value = "bad";
    (doc.querySelector("#wz-connect") as unknown as { click(): void }).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.querySelector("#wz-connect")).not.toBeNull(); // form still up
    expect(doc.body.textContent).toMatch(/not recognized/i);
  });
});
```

- [ ] **Step 2: Run the test — it must FAIL** (`openConnectAccount` does not exist yet)

Run: `npm run test --workspace @buildex/client -- --run src/console-connect-account.test.ts`
Expected: FAIL — `c.openConnectAccount is not a function`.

- [ ] **Step 3: Create `apps/client/web/js/account.js`**

Mirror onboarding.js's proven connect handler, but as a standalone modal reusing the `wz-backdrop`/`wz-card` styling (already in `web/styles/welcome.css`). Note `postJSON` throws on a non-2xx response, so read the error from the thrown value.

```js
"use strict";
// Standalone "connect an account" modal.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// The onboarding wizard connects an account on its final step; this is the SAME flow made reachable
// afterwards - opened from the title-bar sync dot when the workspace is still local (no account).
// Operator copy only: "Company URL", "Setup code", "Connect", "your company" - never push/commit/token.

/**
 * Open a modal to connect an account: a Company URL + Setup code, and a Connect button that POSTs
 * /api/account. On success the modal tears down and the sync surface refreshes (refreshProjects);
 * on a 4xx the server's message shows inline and the form stays up to retry.
 * @returns {void}
 */
function openConnectAccount() {
  const back = elt("div", "wz-backdrop"), card = elt("div", "wz-card");
  back.appendChild(card);
  document.body.appendChild(back);
  let error = "";
  const close = () => back.remove();
  const draw = () => {
    card.innerHTML =
      '<h2 class="wz-t">Connect your account</h2>' +
      '<div class="wz-body"><p>Save your work to your company. Paste the details your company gave you.</p>' +
      '<div class="wz-connect">' +
      '<label class="wz-field">Company URL<input id="wz-baseurl" type="text" inputmode="url" autocomplete="off" placeholder="https://sync.yourcompany.com"></label>' +
      '<label class="wz-field">Setup code<input id="wz-code" type="text" autocomplete="off" placeholder="Paste the code your company gave you"></label>' +
      (error ? '<div class="wz-err">' + esc(error) + '</div>' : '') +
      '<button class="wz-ghost" id="wz-connect" type="button">Connect</button>' +
      '</div></div>' +
      '<div class="wz-actions"><div class="wz-right"><button class="wz-ghost" data-a="cancel">Cancel</button></div></div>';
    card.querySelector('[data-a="cancel"]').onclick = close;
    card.querySelector("#wz-connect").onclick = async () => {
      const baseUrl = card.querySelector("#wz-baseurl").value.trim();
      const setupToken = card.querySelector("#wz-code").value.trim();
      const btn = card.querySelector("#wz-connect");
      btn.disabled = true; btn.textContent = "Connecting…";
      let res;
      try { res = await postJSON("/api/account", { baseUrl, setupToken }); }
      catch (e) { res = (e && e.body) || { error: "Could not reach your company's server - check the URL and try again." }; }
      if (res && res.state === "connected") {
        close();
        if (typeof refreshProjects === "function") refreshProjects().catch(() => {});
      } else {
        error = (res && res.error) || "Could not connect - check the URL and setup code.";
        draw();
      }
    };
  };
  draw();
}
```

Note on the `catch`: confirm how `postJSON` surfaces a non-2xx body in this codebase (grep `function postJSON` in `web/js/*.js` and `web/dom.js`/`web/*.js`). If it rejects with the parsed JSON directly (not `e.body`), adapt the `catch` to read the error from the rejection shape it actually uses — the test's 4xx case (`{ error: "That setup code was not recognized." }`) must render inline. If `postJSON` does NOT reject on 4xx but resolves with the body, drop the try/catch and branch on `res.state`/`res.error` as onboarding.js does.

- [ ] **Step 4: Register the script** in `apps/client/web/index.html`

Add, immediately after the `js/onboarding.js` line:

```html
<script src="js/account.js"></script>
```

- [ ] **Step 5: Wire the dot** in `apps/client/web/js/boot.js`

The dot click is currently:

```js
  $("#sync").onclick = () =>
    switchRight($("#sync").classList.contains("unsaved") ? "pending" : "synclog");
```

Change it so the local (no-account) state opens the connect modal instead of the change log:

```js
  $("#sync").onclick = () => {
    const dot = $("#sync");
    if (dot.classList.contains("local")) { openConnectAccount(); return; } // no account yet → connect
    switchRight(dot.classList.contains("unsaved") ? "pending" : "synclog");
  };
```

- [ ] **Step 6: Update the local tooltip** in `apps/client/web/js/sync.js`

Change the `local:` label so it invites the click:

```js
      local: "Local workspace - click to connect an account",
```

Update the neighboring comment if it references the old wording, and confirm the `dot.title` suffix line still reads well for `local` (it appends " · click for recent changes" to every non-`unsaved` state — change the suffix logic so `local` does NOT get the "recent changes" suffix, since its click now connects):

```js
  dot.title = state === "unsaved" || state === "local" ? label : label + " · click for recent changes";
```

- [ ] **Step 7: Run the console test — it must PASS**

Run: `npm run test --workspace @buildex/client -- --run src/console-connect-account.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 8: Run the full client console suite + the onboarding test (no regression)**

Run: `npm run test --workspace @buildex/client -- --run src/console-render-account.test.ts src/console-connect-account.test.ts`
Expected: PASS (the pre-existing onboarding connect flow is untouched).

- [ ] **Step 9: Commit**

```bash
git add apps/client/web/js/account.js apps/client/web/index.html apps/client/web/js/boot.js apps/client/web/js/sync.js apps/client/src/console-connect-account.test.ts
git commit -m "feat(console): connect an account any time from the title-bar sync dot"
```
