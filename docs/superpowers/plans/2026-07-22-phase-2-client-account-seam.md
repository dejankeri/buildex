# Phase 2 - Client Account Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a local BuildEx org's `core`/`team`/`private` roots to a deployed sync server by pasting a setup token — provision credentials, attach remotes in place, and authenticate every push/fetch with a per-machine token that never touches disk.

**Architecture:** Five small single-purpose modules under `apps/client/src/account/` (provision client, account store, token provider, git-credential env, attach) plus a handful of surgical changes to `SyncEngine`, the composition root, the daemon, and the console. The machine token reaches git only through `GIT_CONFIG_*` environment injected at spawn time as an `http.extraHeader` Basic-auth header — nothing is written to `.git/config`, a remote URL, argv, or a commit. A new `[release-gate:no-token-on-disk]` invariant proves that after a full account-open.

**Tech Stack:** TypeScript (NodeNext, `.js` import specifiers, strict), Vitest, Node 22 built-ins (`node:crypto`, `Buffer`), real `git` shelled via `execFile`. Hermetic tests: injected `fetch`/`Keychain`/`Clock` and `file://` bare repos, no network in unit lanes.

## Global Constraints

Every task's requirements implicitly include this section. Values are exact.

- **The machine token never lands on disk or in argv.** It reaches git ONLY via `GIT_CONFIG_COUNT=1` / `GIT_CONFIG_KEY_0=http.extraHeader` / `GIT_CONFIG_VALUE_0=Authorization: Basic <b64>`, where `<b64>` = `Buffer.from("x:" + token).toString("base64")`. Never in a remote URL, never in `.git/config`, never in a commit, never on a process command line. This is what `scripts/secret-scan.sh`, `invariants/secrets.test.ts`, and the new `[release-gate:no-token-on-disk]` protect.
- **Server auth is HTTP Basic, token in the password field, username arbitrary** (server ignores it; use `"x"`). Confirmed against `apps/sync/src/http/app.ts:121-130,168-177`.
- **Provision wire contract** (`apps/sync`, do NOT modify the server): `POST {baseUrl}/provision` with body `{ "setupToken": string, "machineName": string }` → `200 { "machineToken": "xmachine_…", "refreshToken": "xrefresh_…", "repos": { "core": url, "team": url, "private": url } }`. The `repos` values are full clone URLs `{baseUrl}/git/<name>.git`. **There is no `companyId` or `operatorId` on the wire.** A reused/invalid setup token → `401`.
- **Refresh wire contract:** `POST {baseUrl}/token/refresh` with body `{ "refreshToken": string }` → same shape as provision, both tokens rotated. The old machine token stops authorizing immediately.
- **Per-org secrets in the keychain**, keyed exactly: `org:<orgId>:machine-token` and `org:<orgId>:refresh-token`. The `Keychain` interface (`apps/client/src/keychain/keychain.ts:11-15`) is synchronous: `get(key): string | undefined`, `set(key, value): void`, `delete(key): void`.
- **`account.json` holds no secret, ever.** It lives at `<orgsRoot>/<orgId>/account.json` (sibling of `org.json`). It stores `baseUrl`, the local-root-name → remote-URL map, and the derived `operatorId` and `companySlug` (parsed from the `private-<operatorId>` and `team-<slug>` repo names). It does **not** store `companyId` (not available from `/provision` — see Deviations).
- **The sandbox org refuses to attach.** It is `OrgMeta.sandbox === true` (id `"demo"`, `DEMO_ORG_ID`); it stays local and stays badged.
- **The paste path is permanent**, not scaffolding — it is the offline escape hatch and the path the tests drive. Browser sign-in is Phase 3 and out of scope here.
- **`apps/sync` is not touched by this plan.** All work is in `apps/client` (plus docs). Do not add a dependency to `apps/client` without calling it out; prefer Node built-ins.
- **Hermetic tests only.** Inject `fetch`, `Keychain`, clock, and temp dirs. `attach` runs against `file://` bare repos. No real network in unit lanes.

## Deviations from the spec (and why) — record these in the branch's capture

The approved spec (`docs/superpowers/specs/2026-07-21-sync-account-design.md`) predates the manual-save work and the exact server wire. Four points differ; none change the design:

1. **`account.json` omits `companyId`.** Decision 3 lists `companyId, operatorId`, but `/provision` returns neither (only tokens + repo URLs — verified in `apps/sync/src/http/app.ts:179-190`). `operatorId` and `companySlug` are recoverable from the repo names (`private-<operatorId>`, `team-<companySlug>`); `companyId` is not. Store the two derivable fields; omit `companyId`.
2. **Two listed gaps are already closed** by the manual-save branch and get no task here:
   - `writableDirs` already uses `slotOf()` (`wiring.ts:152`), not `name !== "core"`.
   - `SyncEngineLike` already declares `syncReadonly` and the scheduler already calls it for `core` on the tick (`scheduler.ts`). 
3. **Auth env is merged in `SyncEngine.git()`, not literally in `lib/git-pin.ts`.** `pinnedGit` only shapes argv (`git-pin.ts:18-20`) and is shared with the network-free `unsaved.ts`; putting auth there would wrongly attach a credential header to the read-only counting path. `SyncEngine.git()` (`engine.ts:200-221`) is the single chokepoint for every *network* git op, so the env merges there. The spec's intent (env-only, single chokepoint) is preserved.
4. **`[release-gate:no-token-on-disk]` becomes the sixth registered invariant.** The registry (`invariants/invariants-registry.test.ts:12`) asserts exactly the tagged set, and its own comment says a sixth is added by updating `EXPECTED` + `task invariants`. `task invariants` already selects by `-t "release-gate:"` so it needs no change; only `EXPECTED` and the registry `desc` move from five to six.

---

## File Structure

New (`apps/client/src/account/`, one responsibility each):

| File | Responsibility |
|---|---|
| `credentials.ts` | `gitAuthEnv(token)` → the `GIT_CONFIG_*` triple carrying the Basic-auth header |
| `provision-client.ts` | `provision()` / `refresh()` over an injected `fetch`; typed responses |
| `account-store.ts` | `account.json` (non-secrets) + keychain token pair; parses derived fields |
| `token-provider.ts` | supplies the current token; `rotate()` via `/token/refresh` on auth failure |
| `attach.ts` | add remote, fetch, delegate to the engine (`receive`/`syncReadonly` + first `publish`) |

New tests: one `*.test.ts` beside each module, plus `apps/client/src/invariants/no-token-on-disk.test.ts`.

Modified:

| File | Change |
|---|---|
| `apps/client/src/sync/engine.ts` | `SyncDeps` gains optional `auth`; `git()` merges the header env and retries once on auth failure |
| `apps/client/src/sync/scheduler.ts` | expose per-root results for the status route |
| `apps/client/src/wiring.ts` | construct the account seam per-org; thread engine `auth`; add `accountFn`/`accountState` daemon deps |
| `apps/client/src/orgs/router.ts` | pass the org id / orgs dir the seam needs into the per-org config |
| `apps/client/src/daemon/daemon.ts` | `POST /api/account`, `GET /api/account`; per-root field on `GET /api/sync` |
| `apps/client/web/js/onboarding.js` | replace "coming soon" with a baseUrl + token field that POSTs `/api/account` |
| `apps/client/web/js/sync.js` | retire the `local` copy once an account is connected |
| `apps/client/src/invariants/secrets.test.ts` | per-org keychain key (`org:<orgId>:machine-token`) |
| `apps/client/src/invariants/invariants-registry.test.ts` | `EXPECTED` → six; `desc` wording |

---

### Task 1: `gitAuthEnv` — the credential environment

**Files:**
- Create: `apps/client/src/account/credentials.ts`
- Test: `apps/client/src/account/credentials.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function gitAuthEnv(token: string): Record<string, string>` — the `GIT_CONFIG_*` triple that makes git send `Authorization: Basic <base64("x:"+token)>` on HTTP. Consumed by Task 5 (engine) and Task 6/11 (attach + gate test).

- [ ] **Step 1: Write the failing test**

```ts
// apps/client/src/account/credentials.test.ts
import { describe, it, expect } from "vitest";
import { gitAuthEnv } from "./credentials.js";

describe("gitAuthEnv", () => {
  it("carries the token as an http.extraHeader Basic credential, never as its own field", () => {
    const env = gitAuthEnv("xmachine_deadbeef");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    // Basic auth, token in the PASSWORD half, username "x" (the server ignores the username).
    const expected = "Authorization: Basic " + Buffer.from("x:xmachine_deadbeef").toString("base64");
    expect(env.GIT_CONFIG_VALUE_0).toBe(expected);
    // The raw token appears in NO key as a bare value - only inside the base64 blob.
    expect(env.GIT_CONFIG_VALUE_0.includes("xmachine_deadbeef")).toBe(false);
  });

  it("decodes back to x:<token> - the exact shape the server's basicPassword() parses", () => {
    const env = gitAuthEnv("xmachine_abc123");
    const b64 = env.GIT_CONFIG_VALUE_0.replace("Authorization: Basic ", "");
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("x:xmachine_abc123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/client/src/account/credentials.test.ts`
Expected: FAIL — `credentials.js` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/client/src/account/credentials.ts
// The machine token reaches git ONLY here, as an http.extraHeader Basic credential injected through
// GIT_CONFIG_* environment (git >= 2.31). Nothing is written to disk, to .git/config, to a remote
// URL, or to argv, so no `ps` or secret-scan leak is possible. The server (apps/sync) reads HTTP
// Basic auth and takes the token from the PASSWORD field, ignoring the username - so the username is
// a throwaway "x". This is the invariant `[release-gate:no-token-on-disk]` exists to protect.
export function gitAuthEnv(token: string): Record<string, string> {
  const header = "Authorization: Basic " + Buffer.from("x:" + token).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: header,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/client/src/account/credentials.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/account/credentials.ts apps/client/src/account/credentials.test.ts
git commit -m "feat(account): carry the machine token as an http.extraHeader, never on disk"
```

---

### Task 2: `provision-client` — the two server calls

**Files:**
- Create: `apps/client/src/account/provision-client.ts`
- Test: `apps/client/src/account/provision-client.test.ts`

**Interfaces:**
- Consumes: an injected `fetch` (the DOM/undici `typeof fetch`).
- Produces:
  ```ts
  export interface ProvisionResult {
    machineToken: string;
    refreshToken: string;
    repos: { core: string; team: string; private: string };
  }
  export class ProvisionError extends Error { constructor(message: string, readonly status: number); }
  export function provision(deps: { fetch: typeof fetch; baseUrl: string }, input: { setupToken: string; machineName: string }): Promise<ProvisionResult>;
  export function refresh(deps: { fetch: typeof fetch; baseUrl: string }, refreshToken: string): Promise<ProvisionResult>;
  ```
  Consumed by Task 4 (token provider) and Task 8 (daemon account route).

- [ ] **Step 1: Write the failing test**

```ts
// apps/client/src/account/provision-client.test.ts
import { describe, it, expect } from "vitest";
import { provision, refresh, ProvisionError } from "./provision-client.js";

const OK = {
  machineToken: "xmachine_" + "a".repeat(48),
  refreshToken: "xrefresh_" + "b".repeat(48),
  repos: {
    core: "https://sync.test/git/core.git",
    team: "https://sync.test/git/team-acme.git",
    private: "https://sync.test/git/private-o1.git",
  },
};

function fakeFetch(status: number, body: unknown, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("provision", () => {
  it("posts setupToken + machineName to /provision and returns the credentials", async () => {
    let seenUrl = "", seenBody = "";
    const f = fakeFetch(200, OK, (u, i) => { seenUrl = u; seenBody = String(i.body); });
    const r = await provision({ fetch: f, baseUrl: "https://sync.test" }, { setupToken: "xsetup_t", machineName: "laptop" });
    expect(seenUrl).toBe("https://sync.test/provision");
    expect(JSON.parse(seenBody)).toEqual({ setupToken: "xsetup_t", machineName: "laptop" });
    expect(r).toEqual(OK);
  });

  it("does not put a trailing-slash baseUrl into a doubled path", async () => {
    let seenUrl = "";
    const f = fakeFetch(200, OK, (u) => { seenUrl = u; });
    await provision({ fetch: f, baseUrl: "https://sync.test/" }, { setupToken: "x", machineName: "m" });
    expect(seenUrl).toBe("https://sync.test/provision");
  });

  it("raises a typed ProvisionError carrying the status when the token is rejected", async () => {
    const f = fakeFetch(401, { error: "invalid setup token" });
    await expect(provision({ fetch: f, baseUrl: "https://sync.test" }, { setupToken: "bad", machineName: "m" }))
      .rejects.toMatchObject({ status: 401 });
    await expect(provision({ fetch: f, baseUrl: "https://sync.test" }, { setupToken: "bad", machineName: "m" }))
      .rejects.toBeInstanceOf(ProvisionError);
  });

  it("rejects a 200 whose body is missing a token, rather than returning a half-formed account", async () => {
    const f = fakeFetch(200, { repos: OK.repos }); // no machineToken
    await expect(refresh({ fetch: f, baseUrl: "https://sync.test" }, "xrefresh_x")).rejects.toBeInstanceOf(ProvisionError);
  });
});

describe("refresh", () => {
  it("posts refreshToken to /token/refresh and returns the rotated pair", async () => {
    let seenUrl = "", seenBody = "";
    const f = fakeFetch(200, OK, (u, i) => { seenUrl = u; seenBody = String(i.body); });
    const r = await refresh({ fetch: f, baseUrl: "https://sync.test" }, "xrefresh_old");
    expect(seenUrl).toBe("https://sync.test/token/refresh");
    expect(JSON.parse(seenBody)).toEqual({ refreshToken: "xrefresh_old" });
    expect(r.machineToken).toBe(OK.machineToken);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/client/src/account/provision-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/client/src/account/provision-client.ts
// The two calls the client makes to the sync server. Injected fetch keeps this hermetic. The server
// contract is fixed (apps/sync/src/http/app.ts:82-91): both endpoints take a JSON body and return
// { machineToken, refreshToken, repos:{core,team,private} }. A rejected setup token is a 401.
export interface ProvisionResult {
  machineToken: string;
  refreshToken: string;
  repos: { core: string; team: string; private: string };
}

export class ProvisionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProvisionError";
  }
}

interface Deps {
  fetch: typeof fetch;
  baseUrl: string;
}

function isResult(v: unknown): v is ProvisionResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const repos = r.repos as Record<string, unknown> | undefined;
  return (
    typeof r.machineToken === "string" &&
    typeof r.refreshToken === "string" &&
    !!repos &&
    typeof repos.core === "string" &&
    typeof repos.team === "string" &&
    typeof repos.private === "string"
  );
}

async function post(deps: Deps, path: string, body: unknown): Promise<ProvisionResult> {
  const url = deps.baseUrl.replace(/\/+$/, "") + path; // one join, no doubled slash
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Offline / DNS / connection refused - surfaced as a 0-status ProvisionError so callers can tell
    // "server said no" (401) from "could not reach the server" (0).
    throw new ProvisionError(e instanceof Error ? e.message : "network error", 0);
  }
  if (!res.ok) {
    let msg = `sync server returned ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* non-JSON error body - keep the status message */
    }
    throw new ProvisionError(msg, res.status);
  }
  const parsed = (await res.json()) as unknown;
  if (!isResult(parsed)) throw new ProvisionError("sync server returned a malformed credential response", res.status);
  return parsed;
}

export function provision(deps: Deps, input: { setupToken: string; machineName: string }): Promise<ProvisionResult> {
  return post(deps, "/provision", { setupToken: input.setupToken, machineName: input.machineName });
}

export function refresh(deps: Deps, refreshToken: string): Promise<ProvisionResult> {
  return post(deps, "/token/refresh", { refreshToken });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/client/src/account/provision-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/account/provision-client.ts apps/client/src/account/provision-client.test.ts
git commit -m "feat(account): provision + token-refresh client over an injected fetch"
```

---

### Task 3: `account-store` — non-secrets on disk, tokens in the keychain

**Files:**
- Create: `apps/client/src/account/account-store.ts`
- Test: `apps/client/src/account/account-store.test.ts`

**Interfaces:**
- Consumes: `Keychain` (`../keychain/keychain.js`), an org id, the org dir path, and `node:fs`. `ProvisionResult` from Task 2.
- Produces:
  ```ts
  export interface StoredAccount {
    baseUrl: string;
    repos: { core: string; team: string; private: string };
    operatorId: string;   // parsed from private-<operatorId>.git
    companySlug: string;  // parsed from team-<slug>.git
  }
  export interface AccountTokens { machineToken: string; refreshToken: string; }
  export function machineTokenKey(orgId: string): string; // `org:<orgId>:machine-token`
  export function refreshTokenKey(orgId: string): string;  // `org:<orgId>:refresh-token`
  export class AccountStore {
    constructor(deps: { orgId: string; orgDir: string; keychain: Keychain });
    save(baseUrl: string, result: ProvisionResult): StoredAccount; // writes account.json + both tokens
    load(): StoredAccount | null;      // reads account.json; null if absent
    tokens(): AccountTokens | null;    // reads the keychain pair; null if either is missing
    setTokens(t: AccountTokens): void; // rotation persists the new pair
    connected(): boolean;              // load() !== null
  }
  ```
  Consumed by Task 4 (token provider), Task 7 (wiring), Task 8 (daemon route).

- [ ] **Step 1: Write the failing test**

```ts
// apps/client/src/account/account-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { AccountStore, machineTokenKey, refreshTokenKey } from "./account-store.js";

const RESULT = {
  machineToken: "xmachine_" + "a".repeat(48),
  refreshToken: "xrefresh_" + "b".repeat(48),
  repos: {
    core: "https://sync.test/git/core.git",
    team: "https://sync.test/git/team-acme.git",
    private: "https://sync.test/git/private-o1.git",
  },
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "buildex-acct-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make() {
  const keychain = new InMemoryKeychain();
  return { keychain, store: new AccountStore({ orgId: "org1", orgDir: dir, keychain }) };
}

describe("AccountStore", () => {
  it("keys the token pair per-org, exactly", () => {
    expect(machineTokenKey("org1")).toBe("org:org1:machine-token");
    expect(refreshTokenKey("org1")).toBe("org:org1:refresh-token");
  });

  it("writes non-secrets to account.json and the tokens ONLY to the keychain", () => {
    const { keychain, store } = make();
    const acct = store.save("https://sync.test", RESULT);
    expect(acct.operatorId).toBe("o1");     // parsed from private-o1.git
    expect(acct.companySlug).toBe("acme");  // parsed from team-acme.git
    expect(acct.repos).toEqual(RESULT.repos);

    const raw = readFileSync(join(dir, "account.json"), "utf8");
    expect(raw).not.toContain("xmachine_"); // NO token on disk
    expect(raw).not.toContain("xrefresh_");
    expect(JSON.parse(raw).baseUrl).toBe("https://sync.test");

    expect(keychain.get("org:org1:machine-token")).toBe(RESULT.machineToken);
    expect(keychain.get("org:org1:refresh-token")).toBe(RESULT.refreshToken);
  });

  it("round-trips: load() and tokens() return what save() stored", () => {
    const { store } = make();
    store.save("https://sync.test", RESULT);
    expect(store.connected()).toBe(true);
    expect(store.load()).toMatchObject({ baseUrl: "https://sync.test", operatorId: "o1", companySlug: "acme" });
    expect(store.tokens()).toEqual({ machineToken: RESULT.machineToken, refreshToken: RESULT.refreshToken });
  });

  it("reports not-connected before any save", () => {
    const { store } = make();
    expect(store.connected()).toBe(false);
    expect(store.load()).toBeNull();
    expect(store.tokens()).toBeNull();
  });

  it("setTokens rotates the keychain pair without rewriting account.json", () => {
    const { keychain, store } = make();
    store.save("https://sync.test", RESULT);
    store.setTokens({ machineToken: "xmachine_new", refreshToken: "xrefresh_new" });
    expect(keychain.get("org:org1:machine-token")).toBe("xmachine_new");
    expect(existsSync(join(dir, "account.json"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/client/src/account/account-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/client/src/account/account-store.ts
// The split the whole feature turns on: secrets in the OS keychain, everything else in a plain JSON
// file. account.json records baseUrl and the returned clone URLs (the server owns repo naming, so we
// keep its URLs verbatim) plus the operatorId/companySlug we can derive from the repo names. It never
// holds a token. The token pair lives under per-org keychain keys so two companies never share one
// credential (invariant 6).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Keychain } from "../keychain/keychain.js";
import type { ProvisionResult } from "./provision-client.js";

export interface StoredAccount {
  baseUrl: string;
  repos: { core: string; team: string; private: string };
  operatorId: string;
  companySlug: string;
}
export interface AccountTokens {
  machineToken: string;
  refreshToken: string;
}

export const machineTokenKey = (orgId: string): string => `org:${orgId}:machine-token`;
export const refreshTokenKey = (orgId: string): string => `org:${orgId}:refresh-token`;

/** Pull the operator id out of `…/git/private-<id>.git` and the slug out of `…/git/team-<slug>.git`.
 *  These are the only identity fields /provision leaves recoverable - companyId is not on the wire. */
function derive(repos: ProvisionResult["repos"]): { operatorId: string; companySlug: string } {
  const priv = /\/private-([a-z0-9_-]+)\.git$/.exec(repos.private);
  const team = /\/team-([a-z0-9_-]+)\.git$/.exec(repos.team);
  return { operatorId: priv?.[1] ?? "", companySlug: team?.[1] ?? "" };
}

export class AccountStore {
  private readonly path: string;
  constructor(private readonly deps: { orgId: string; orgDir: string; keychain: Keychain }) {
    this.path = join(deps.orgDir, "account.json");
  }

  save(baseUrl: string, result: ProvisionResult): StoredAccount {
    const { operatorId, companySlug } = derive(result.repos);
    const account: StoredAccount = { baseUrl, repos: result.repos, operatorId, companySlug };
    mkdirSync(this.deps.orgDir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(account, null, 2) + "\n");
    this.setTokens({ machineToken: result.machineToken, refreshToken: result.refreshToken });
    return account;
  }

  load(): StoredAccount | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as StoredAccount;
    } catch {
      return null; // a corrupt file reads as not-connected rather than crashing the daemon
    }
  }

  tokens(): AccountTokens | null {
    const machineToken = this.deps.keychain.get(machineTokenKey(this.deps.orgId));
    const refreshToken = this.deps.keychain.get(refreshTokenKey(this.deps.orgId));
    if (!machineToken || !refreshToken) return null;
    return { machineToken, refreshToken };
  }

  setTokens(t: AccountTokens): void {
    this.deps.keychain.set(machineTokenKey(this.deps.orgId), t.machineToken);
    this.deps.keychain.set(refreshTokenKey(this.deps.orgId), t.refreshToken);
  }

  connected(): boolean {
    return this.load() !== null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/client/src/account/account-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/account/account-store.ts apps/client/src/account/account-store.test.ts
git commit -m "feat(account): per-org account store - account.json for non-secrets, keychain for tokens"
```

---

### Task 4: `token-provider` — current token, and rotate-on-failure

**Files:**
- Create: `apps/client/src/account/token-provider.ts`
- Test: `apps/client/src/account/token-provider.test.ts`

**Interfaces:**
- Consumes: `AccountStore` (Task 3), `refresh` (Task 2), an injected `fetch`.
- Produces:
  ```ts
  export interface TokenProvider {
    current(): string | undefined;      // the machine token, or undefined with no account
    rotate(): Promise<boolean>;         // refresh via the server; persist the new pair; true on success
  }
  export function makeTokenProvider(deps: { store: AccountStore; fetch: typeof fetch }): TokenProvider;
  ```
  Consumed by Task 5 (engine `auth.onAuthError` → `rotate`, `auth.headerEnv` from `current`) and Task 7 (wiring).

- [ ] **Step 1: Write the failing test**

```ts
// apps/client/src/account/token-provider.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { AccountStore } from "./account-store.js";
import { makeTokenProvider } from "./token-provider.js";

const RESULT = {
  machineToken: "xmachine_old", refreshToken: "xrefresh_old",
  repos: { core: "https://s/git/core.git", team: "https://s/git/team-acme.git", private: "https://s/git/private-o1.git" },
};
const ROTATED = { ...RESULT, machineToken: "xmachine_new", refreshToken: "xrefresh_new" };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "buildex-tp-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function store() {
  const s = new AccountStore({ orgId: "o", orgDir: dir, keychain: new InMemoryKeychain() });
  s.save("https://s", RESULT);
  return s;
}
const fetchWith = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("token-provider", () => {
  it("hands out the stored machine token", () => {
    const tp = makeTokenProvider({ store: store(), fetch: fetchWith(200, ROTATED) });
    expect(tp.current()).toBe("xmachine_old");
  });

  it("undefined when there is no account", () => {
    const s = new AccountStore({ orgId: "o", orgDir: dir, keychain: new InMemoryKeychain() });
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(200, ROTATED) });
    expect(tp.current()).toBeUndefined();
  });

  it("rotate() refreshes, persists the new pair, and current() reflects it", async () => {
    const s = store();
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(200, ROTATED) });
    expect(await tp.rotate()).toBe(true);
    expect(tp.current()).toBe("xmachine_new");
    expect(s.tokens()!.refreshToken).toBe("xrefresh_new");
  });

  it("rotate() returns false and leaves the old token when the server rejects the refresh", async () => {
    const s = store();
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(401, { error: "revoked" }) });
    expect(await tp.rotate()).toBe(false);
    expect(tp.current()).toBe("xmachine_old"); // unchanged - the account is not silently wiped
  });

  it("rotate() returns false with no account rather than throwing", async () => {
    const s = new AccountStore({ orgId: "o", orgDir: dir, keychain: new InMemoryKeychain() });
    const tp = makeTokenProvider({ store: s, fetch: fetchWith(200, ROTATED) });
    expect(await tp.rotate()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/client/src/account/token-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/client/src/account/token-provider.ts
// Supplies the current machine token to the engine and knows how to rotate it. A rotation is only
// attempted when a push/fetch fails auth (the engine calls rotate() then retries once). A failed
// rotation must NOT wipe the account - the token may be revoked, but the operator's work stays local
// and the status surfaces `needs-help`; the last-known pair is left in place so a later manual save
// can try again.
import type { AccountStore } from "./account-store.js";
import { refresh } from "./provision-client.js";

export interface TokenProvider {
  current(): string | undefined;
  rotate(): Promise<boolean>;
}

export function makeTokenProvider(deps: { store: AccountStore; fetch: typeof fetch }): TokenProvider {
  return {
    current(): string | undefined {
      return deps.store.tokens()?.machineToken;
    },
    async rotate(): Promise<boolean> {
      const account = deps.store.load();
      const tokens = deps.store.tokens();
      if (!account || !tokens) return false;
      try {
        const rotated = await refresh({ fetch: deps.fetch, baseUrl: account.baseUrl }, tokens.refreshToken);
        deps.store.setTokens({ machineToken: rotated.machineToken, refreshToken: rotated.refreshToken });
        return true;
      } catch {
        return false; // revoked / offline - leave the stored pair untouched
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/client/src/account/token-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/account/token-provider.ts apps/client/src/account/token-provider.test.ts
git commit -m "feat(account): token provider that rotates via /token/refresh on demand"
```

---

### Task 5: `SyncEngine` authenticates git, and retries once on auth failure

**Files:**
- Modify: `apps/client/src/sync/engine.ts` (`SyncDeps` at 28-32; `git()` at 200-221)
- Test: `apps/client/src/sync/engine-auth.test.ts` (new — keep the large existing `engine.test.ts` untouched)

**Interfaces:**
- Consumes: an optional `auth` object supplied by wiring (Task 7), shaped from the token provider (Task 4).
- Produces: `SyncDeps` gains `auth?: EngineAuth`:
  ```ts
  export interface EngineAuth {
    headerEnv(): Record<string, string> | undefined; // gitAuthEnv(currentToken), or undefined if none
    onAuthError(): Promise<boolean>;                  // rotate; true if a retry should be attempted
  }
  ```
  `git()` merges `headerEnv()` into the spawn env, and on a git failure whose stderr looks like an auth rejection it calls `onAuthError()` once and retries with a freshly-read header.

- [ ] **Step 1: Write the failing test**

```ts
// apps/client/src/sync/engine-auth.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SyncEngine, type EngineAuth } from "./engine.js";
import { gitAuthEnv } from "../account/credentials.js";

// A fake remote that captures the Authorization http.extraHeader by using a local helper `git`
// wrapper is heavy; instead assert at the env layer: drive publish against a file:// bare remote
// (which needs no auth) and confirm the header env is present on the spawned git, and that an
// auth-classified failure triggers exactly one rotate + retry.

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "buildex-eauth-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function clonedWithRemote(): string {
  const bare = join(root, "r.git");
  git(["init", "--bare", "--initial-branch=main", bare], root);
  const seed = join(root, "seed");
  git(["clone", `file://${bare}`, seed], root);
  writeFileSync(join(seed, "a.md"), "x\n");
  git(["add", "."], seed); git(["commit", "-m", "seed"], seed); git(["push", "origin", "HEAD:main"], seed);
  const dir = join(root, "work");
  git(["clone", `file://${bare}`, dir], root);
  return dir;
}

describe("SyncEngine auth", () => {
  it("retries a push exactly once after an auth failure, then succeeds", async () => {
    const dir = clonedWithRemote();
    writeFileSync(join(dir, "b.md"), "y\n");
    let rotations = 0;
    let firstTry = true;
    // First push is forced to look like an auth failure; onAuthError flips the gate so the retry runs.
    const auth: EngineAuth = {
      headerEnv: () => (firstTry ? { GIT_CONFIG_COUNT: "0" } : gitAuthEnv("xmachine_ok")),
      onAuthError: async () => { rotations++; firstTry = false; return true; },
    };
    const engine = new SyncEngine({ now: Date.now, actor: "t", auth, classifyAuthError: () => firstTry });
    const r = await engine.publish(dir);
    expect(rotations).toBe(1);      // rotated once...
    expect(r).toBe("ok");           // ...and the retry succeeded
  });

  it("does not rotate when the failure is not an auth failure", async () => {
    const dir = clonedWithRemote();
    let rotations = 0;
    const auth: EngineAuth = { headerEnv: () => undefined, onAuthError: async () => { rotations++; return true; } };
    // A clean publish (no failure) must never call onAuthError.
    writeFileSync(join(dir, "c.md"), "z\n");
    const engine = new SyncEngine({ now: Date.now, actor: "t", auth });
    await engine.publish(dir);
    expect(rotations).toBe(0);
  });
});
```

> Note for the implementer: the first test injects a test-only `classifyAuthError` seam so the retry path is exercised deterministically without a live 401. If you prefer, expose `classifyAuthError` as an optional `SyncDeps` field defaulting to a real stderr matcher (`/\b(401|403)\b|Authentication failed|could not read Username|invalid credentials/i`). Keep the default matcher in the module; only the test overrides it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/client/src/sync/engine-auth.test.ts`
Expected: FAIL — `EngineAuth` / `auth` not on `SyncDeps`.

- [ ] **Step 3: Write minimal implementation**

Add to `SyncDeps` (engine.ts:28-32) and the `git()` method (engine.ts:200-221):

```ts
// --- add near the top-level types ---
export interface EngineAuth {
  /** gitAuthEnv(currentToken), or undefined when there is no account yet (local-only). */
  headerEnv(): Record<string, string> | undefined;
  /** Rotate the token after an auth-classified failure; resolve true if a retry should be made. */
  onAuthError(): Promise<boolean>;
}

export interface SyncDeps {
  now: () => number;
  actor: string;
  /** Present once an account is attached; injects the credential header and rotates on 401/403. */
  auth?: EngineAuth;
  /** Classify a git failure's stderr as an auth rejection. Overridable only for tests. */
  classifyAuthError?: (stderr: string) => boolean;
}

const DEFAULT_AUTH_RE = /\b(401|403)\b|Authentication failed|could not read Username|invalid credentials/i;
```

```ts
// --- replace the body of the private git() method ---
private async git(args: string[], cwd: string): Promise<string> {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: this.deps.actor,
    GIT_AUTHOR_EMAIL: `${this.deps.actor}@buildex.local`,
    GIT_COMMITTER_NAME: this.deps.actor,
    GIT_COMMITTER_EMAIL: `${this.deps.actor}@buildex.local`,
  };
  const run = (): Promise<{ stdout: string }> =>
    execFileAsync("git", pinnedGit(args), {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...base, ...(this.deps.auth?.headerEnv() ?? {}) }, // header read FRESH each attempt
    });
  try {
    return (await run()).stdout;
  } catch (e) {
    // One rotate-and-retry when the failure is an auth rejection AND we have a way to rotate. Local
    // ops never hit this (no network → no 401); only fetch/push can. A second failure propagates -
    // the scheduler already turns a thrown publish into `needs-help` and never loses local work.
    const stderr = (e as { stderr?: string })?.stderr ?? (e instanceof Error ? e.message : "");
    const classify = this.deps.classifyAuthError ?? ((s: string) => DEFAULT_AUTH_RE.test(s));
    if (this.deps.auth && classify(String(stderr)) && (await this.deps.auth.onAuthError())) {
      return (await run()).stdout; // retry once with the rotated header (headerEnv re-read above)
    }
    throw e;
  }
}
```

(Keep `GIT_TIMEOUT_MS`, `GIT_MAX_BUFFER`, `execFileAsync`, and `pinnedGit` imports exactly as they already are in the file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/client/src/sync/engine-auth.test.ts apps/client/src/sync/engine.test.ts`
Expected: PASS — the new auth tests pass and the full existing engine suite is unaffected (the `auth`/`classifyAuthError` fields are optional; every current construction omits them).

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/sync/engine.ts apps/client/src/sync/engine-auth.test.ts
git commit -m "feat(sync): inject the git credential header in the engine, rotate once on auth failure"
```

---

### Task 6: `attach` — remotes in place, then delegate to the engine

**Files:**
- Create: `apps/client/src/account/attach.ts`
- Test: `apps/client/src/account/attach.test.ts`

**Interfaces:**
- Consumes: `SyncEngine` (`receive`, `syncReadonly`, `publish`, `hasRemote`, and a new tiny `addRemote`), the roots list, and the provisioned URL map. `StoredAccount.repos` from Task 3.
- Produces:
  ```ts
  export interface AttachResult { status: "connected" | "needs-help"; }
  export function attachOrg(deps: {
    engine: SyncEngine;
    roots: { name: string; dir: string }[];   // the org's local roots
    repos: { core: string; team: string; private: string };
    sandbox: boolean;
  }): Promise<AttachResult>;
  ```
  Consumed by Task 8 (daemon account route).

Add one small primitive to `SyncEngine` (engine.ts) that attach needs — set/replace a root's `origin`:
```ts
/** Point (or re-point) a root's `origin` at `url`, idempotently. No fetch, no auth needed. */
async addRemote(dir: string, url: string): Promise<void> {
  if (await this.hasRemote(dir)) await this.git(["remote", "set-url", "origin", url], dir);
  else await this.git(["remote", "add", "origin", url], dir);
}
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/client/src/account/attach.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SyncEngine } from "../sync/engine.js";
import { attachOrg } from "./attach.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "buildex-attach-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function bare(name: string): string {
  const b = join(root, `${name}.git`);
  git(["init", "--bare", "--initial-branch=main", b], root);
  return `file://${b}`;
}
function localRoot(name: string, seedFile: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(["init", "--initial-branch=main", "."], dir);
  writeFileSync(join(dir, seedFile), "local\n");
  git(["add", "-A"], dir); git(["commit", "-m", "local"], dir);
  return dir;
}
const engine = () => new SyncEngine({ now: Date.now, actor: "t" });
function repos() { return { core: bare("core"), team: bare("team-acme"), private: bare("private-o1") }; }

describe("attachOrg", () => {
  it("attaches writable roots to an empty upstream and pushes local history up (first operator)", async () => {
    const roots = [
      { name: "core", dir: localRoot("core", "c.md") },
      { name: "team", dir: localRoot("team", "t.md") },
      { name: "private", dir: localRoot("private", "p.md") },
    ];
    const r = repos();
    const res = await attachOrg({ engine: engine(), roots, repos: r, sandbox: false });
    expect(res.status).toBe("connected");
    // team's local commit reached the bare remote; core (read-only) did NOT get pushed.
    const teamRefs = git(["ls-remote", r.team.replace("file://", "")], root);
    expect(teamRefs).toContain("refs/heads/main");
    const coreRefs = git(["ls-remote", r.core.replace("file://", "")], root);
    expect(coreRefs.includes("refs/heads/main")).toBe(false); // core is pull-only; attach never pushes it
  });

  it("is idempotent - re-running attaches once more without error and re-points origin", async () => {
    const roots = [
      { name: "core", dir: localRoot("core", "c.md") },
      { name: "team", dir: localRoot("team", "t.md") },
      { name: "private", dir: localRoot("private", "p.md") },
    ];
    const r = repos();
    await attachOrg({ engine: engine(), roots, repos: r, sandbox: false });
    const res = await attachOrg({ engine: engine(), roots, repos: r, sandbox: false }); // again
    expect(res.status).toBe("connected");
    expect(git(["remote", "get-url", "origin"], roots[1]!.dir).trim()).toBe(r.team);
  });

  it("refuses to attach a sandbox org", async () => {
    const roots = [{ name: "team", dir: localRoot("team", "t.md") }];
    await expect(attachOrg({ engine: engine(), roots, repos: repos(), sandbox: true })).rejects.toThrow(/sandbox/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/client/src/account/attach.test.ts`
Expected: FAIL — module / `addRemote` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/client/src/account/attach.ts
// Connect an org's local roots to the cloud IN PLACE - never clone, never move, so existing local
// work is kept. Per root: point origin at the provisioned URL, fetch, then hand off to the engine
// that already knows every upstream state (empty, non-empty, divergent). core is read-only: it takes
// syncReadonly and is never pushed. The writable roots receive, then get ONE explicit first publish -
// connecting an account is the single moment the operator has unambiguously consented to sending
// everything they have. Idempotent per root: re-running re-points origin and is safe to resume.
import type { SyncEngine } from "../sync/engine.js";
import { slotOf } from "../brain/catalog.js";

export interface AttachResult {
  status: "connected" | "needs-help";
}

export async function attachOrg(deps: {
  engine: SyncEngine;
  roots: { name: string; dir: string }[];
  repos: { core: string; team: string; private: string };
  sandbox: boolean;
}): Promise<AttachResult> {
  if (deps.sandbox) throw new Error("the sandbox org is local-only and cannot attach an account");

  let needsHelp = false;
  const writable: string[] = [];

  for (const root of deps.roots) {
    const slot = slotOf(root.name);
    const url = slot === "core" ? deps.repos.core : slot === "team" ? deps.repos.team : slot === "private" ? deps.repos.private : undefined;
    if (!url) continue; // an unknown root slot has no remote to attach

    await deps.engine.addRemote(root.dir, url);

    if (slot === "core") {
      // Read-only. syncReadonly fetches and resets onto the remote, backing up any local divergence
      // (the stub→provisioned migration) via the engine's existing .conflicts path.
      try {
        await deps.engine.syncReadonly(root.dir);
      } catch {
        /* offline: core is rebuilt from the remote on the next pull tick */
      }
    } else {
      const r = await deps.engine.receive(root.dir); // fetch + rebase onto origin/main
      if (r === "needs-help") needsHelp = true;
      writable.push(root.dir);
    }
  }

  // The first publish - the operator's consent to send everything they already have.
  for (const dir of writable) {
    const r = await deps.engine.publish(dir);
    if (r === "needs-help") needsHelp = true;
  }

  return { status: needsHelp ? "needs-help" : "connected" };
}
```

Also add the `addRemote` method to `SyncEngine` (shown in Interfaces above).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/client/src/account/attach.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/account/attach.ts apps/client/src/account/attach.test.ts apps/client/src/sync/engine.ts
git commit -m "feat(account): attach remotes in place and delegate to the sync engine"
```

---

### Task 7: Wire the account seam into the composition root

**Files:**
- Modify: `apps/client/src/wiring.ts` (`ClientConfig` 51-111; keychain 223; engine 150; `createDaemon` 709)
- Modify: `apps/client/src/orgs/router.ts` (per-org config at 69-91; `OrgBaseConfig` 20)
- Test: `apps/client/src/sync/account-wiring.test.ts` (new — drive `buildClientHandler` with an org that has a stored account and assert the engine authenticates)

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: `buildClientHandler` constructs, per org: an `AccountStore` (needs `orgId` + `orgDir`), a `TokenProvider`, and passes the engine an `auth` built from them:
  ```ts
  const account = new AccountStore({ orgId, orgDir, keychain });
  const tokenProvider = makeTokenProvider({ store: account, fetch });
  const sync = new SyncEngine({
    now: Date.now, actor,
    auth: {
      headerEnv: () => { const t = tokenProvider.current(); return t ? gitAuthEnv(t) : undefined; },
      onAuthError: () => tokenProvider.rotate(),
    },
  });
  ```
  `ClientConfig` gains `orgId?: string`, `orgDir?: string`, and an optional injected `fetch?: typeof fetch` (defaulting to global `fetch`) so tests stay hermetic. `orgs/router.ts` populates `orgId`/`orgDir` from the active org (`org.id`, `orgDir(org.id)`); `OrgBaseConfig`'s `Omit` must not exclude them.

- [ ] **Step 1: Write the failing test**

```ts
// apps/client/src/sync/account-wiring.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { AccountStore } from "../account/account-store.js";
import { makeTokenProvider } from "../account/token-provider.js";
import { gitAuthEnv } from "../account/credentials.js";
import { SyncEngine } from "./engine.js";

// This is a focused wiring test: it asserts the exact auth object buildClientHandler must construct,
// so a regression that drops the header from the engine is caught here even before an integration run.
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "buildex-aw-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("account wiring", () => {
  it("an org with a stored account yields an engine auth that emits the credential header", () => {
    const store = new AccountStore({ orgId: "o1", orgDir: dir, keychain: new InMemoryKeychain() });
    store.save("https://s", {
      machineToken: "xmachine_tok", refreshToken: "xrefresh_r",
      repos: { core: "https://s/git/core.git", team: "https://s/git/team-a.git", private: "https://s/git/private-o1.git" },
    });
    const tp = makeTokenProvider({ store, fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    const auth = { headerEnv: () => { const t = tp.current(); return t ? gitAuthEnv(t) : undefined; }, onAuthError: () => tp.rotate() };
    // The header the engine will spawn with must carry the stored token, base64'd - never bare.
    const env = auth.headerEnv()!;
    expect(env.GIT_CONFIG_VALUE_0).toBe("Authorization: Basic " + Buffer.from("x:xmachine_tok").toString("base64"));
    // And a local-only org (no account) yields no header at all.
    const empty = new AccountStore({ orgId: "o2", orgDir: join(dir, "empty"), keychain: new InMemoryKeychain() });
    const tp2 = makeTokenProvider({ store: empty, fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    expect((tp2.current() ? gitAuthEnv(tp2.current()!) : undefined)).toBeUndefined();
    // Sanity: the engine accepts the auth shape.
    expect(() => new SyncEngine({ now: Date.now, actor: "t", auth })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/client/src/sync/account-wiring.test.ts`
Expected: FAIL first only if imports are missing; once Tasks 1-5 exist this focused test passes. Its real purpose is to lock the wiring contract — after wiring `buildClientHandler`, run the app-boot smoke below.

> Implementer note: this task's *code* change is in `wiring.ts`/`orgs/router.ts`; the test above pins the auth-object shape. Verify the wiring itself by running the existing daemon/boot suites (Step 4) — they construct `buildClientHandler` and must stay green with the new optional config fields.

- [ ] **Step 3: Write the wiring changes**

In `wiring.ts`:
- Add to `ClientConfig`: `orgId?: string; orgDir?: string; fetch?: typeof fetch;`
- After the keychain is built (`wiring.ts:223`), before the engine (`wiring.ts:150` — move the engine construction to after the keychain, or read keychain earlier; keep order legal):
  ```ts
  const fetchImpl = config.fetch ?? fetch;
  const account = config.orgId && config.orgDir
    ? new AccountStore({ orgId: config.orgId, orgDir: config.orgDir, keychain })
    : undefined;
  const tokenProvider = account ? makeTokenProvider({ store: account, fetch: fetchImpl }) : undefined;
  const engineAuth = tokenProvider
    ? { headerEnv: () => { const t = tokenProvider.current(); return t ? gitAuthEnv(t) : undefined; }, onAuthError: () => tokenProvider.rotate() }
    : undefined;
  const sync = new SyncEngine({ now: Date.now, actor, ...(engineAuth ? { auth: engineAuth } : {}) });
  ```
- Expose `account` and `tokenProvider` to the daemon deps added in Task 8 (via the `createDaemon({...})` call at 709).

In `orgs/router.ts`:
- In `activate()` (69-91), set `orgId: org.id` and `orgDir: this.orgs.orgDir(org.id)` on the `ClientConfig` it builds. `orgDir` is `OrgManager`'s existing private join; expose a public `orgDir(id): string` on `OrgManager` if not already public (it is used internally at manager.ts:65-67 — add a public accessor if needed).
- Ensure `OrgBaseConfig`'s `Omit<ClientConfig, ...>` does not exclude `orgId | orgDir | fetch`.

- [ ] **Step 4: Run the boot + daemon suites to verify nothing regressed**

Run: `npx vitest run apps/client/src/sync/account-wiring.test.ts apps/client/src/orgs apps/client/src/daemon/daemon.test.ts`
Expected: PASS — new fields are optional; existing boots that omit `orgId`/`orgDir` build a local-only engine exactly as before.

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/wiring.ts apps/client/src/orgs/router.ts apps/client/src/orgs/manager.ts apps/client/src/sync/account-wiring.test.ts
git commit -m "feat(account): construct the account store + token provider per org and authenticate the engine"
```

---

### Task 8: Daemon routes — `POST /api/account`, `GET /api/account`

**Files:**
- Modify: `apps/client/src/daemon/daemon.ts` (`DaemonDeps` ~124-200; route table near the `/api/sync` routes at 626-631)
- Modify: `apps/client/src/wiring.ts` (populate the new deps from Task 7's `account`/`tokenProvider`)
- Test: `apps/client/src/daemon/account-route.test.ts` (new)

**Interfaces:**
- Consumes: an account controller assembled in wiring (provision → attach → first publish) and an account-state reader.
- Produces: two `DaemonDeps` fields:
  ```ts
  /** Open an account: provision with the pasted token, attach remotes, publish once. */
  openAccount?: (input: { baseUrl: string; setupToken: string }) => Promise<{ state: "connected" | "needs-help" }>;
  /** Current account state for the console. */
  accountState?: () => { state: "local" | "connected"; operatorId?: string; companySlug?: string; remotes?: { core: string; team: string; private: string } };
  ```
  Routes:
  - `POST /api/account { baseUrl, setupToken }` → `openAccount(...)`; a sandbox org or a provision `401` maps to a terse non-500 (`409`/`400`); success returns `{ state }`.
  - `GET /api/account` → `accountState()`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/client/src/daemon/account-route.test.ts (uses the makeDaemon helper pattern from daemon.test.ts)
import { describe, it, expect } from "vitest";
import { createDaemon } from "./daemon.js";
import { Gate } from "../gate/gate.js";
import { PolicyEngine, type PolicyPreset } from "../gate/policy.js";
import { ApprovalBroker } from "../gate/approval.js";
import type { UiEvent } from "../agent/types.js";

const preset: PolicyPreset = { allow: ["Read"], ask: ["Bash"], deny: [], default: "ask" };
function makeDaemon(over: Partial<Parameters<typeof createDaemon>[0]> = {}) {
  const broker = new ApprovalBroker({ idFactory: () => "c1", now: () => 0 });
  return createDaemon({
    workspace: "/ws", roots: [], gate: new Gate(new PolicyEngine(preset), broker), broker,
    async *runPrompt() { yield { kind: "done", sessionId: "s" } as UiEvent; },
    buildMap: () => ({ nodes: [], edges: [] }), syncFn: async () => "ok", ...over,
  });
}
const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/account", () => {
  it("POST opens an account and returns the resulting state", async () => {
    let seen: unknown;
    const app = makeDaemon({ openAccount: async (i) => { seen = i; return { state: "connected" }; } });
    const res = await app(post("/api/account", { baseUrl: "https://s", setupToken: "xsetup_t" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "connected" });
    expect(seen).toEqual({ baseUrl: "https://s", setupToken: "xsetup_t" });
  });

  it("POST maps a rejected setup token to a terse 400, never a 500", async () => {
    const app = makeDaemon({ openAccount: async () => { throw Object.assign(new Error("invalid setup token"), { status: 401 }); } });
    const res = await app(post("/api/account", { baseUrl: "https://s", setupToken: "bad" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid setup token/);
  });

  it("POST refuses the sandbox org with 409", async () => {
    const app = makeDaemon({ openAccount: async () => { throw new Error("the sandbox org is local-only and cannot attach an account"); } });
    const res = await app(post("/api/account", { baseUrl: "https://s", setupToken: "x" }));
    expect(res.status).toBe(409);
  });

  it("GET reports local before any account is opened", async () => {
    const app = makeDaemon({ accountState: () => ({ state: "local" }) });
    expect(await (await app(new Request("http://127.0.0.1/api/account"))).json()).toEqual({ state: "local" });
  });

  it("GET reports the connected identity once opened", async () => {
    const app = makeDaemon({ accountState: () => ({ state: "connected", operatorId: "o1", companySlug: "acme", remotes: { core: "u", team: "u", private: "u" } }) });
    expect(await (await app(new Request("http://127.0.0.1/api/account"))).json()).toMatchObject({ state: "connected", operatorId: "o1", companySlug: "acme" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/client/src/daemon/account-route.test.ts`
Expected: FAIL — routes not present (404).

- [ ] **Step 3: Write the routes**

Add to `DaemonDeps` the two optional fields shown in Interfaces. Add routes beside the existing `/api/sync` block (daemon.ts:626-631):

```ts
if (method === "POST" && deps.openAccount && path === "/api/account") {
  const b = await body<{ baseUrl: string; setupToken: string }>(req, { baseUrl: "string!", setupToken: "string!" });
  try {
    return json(await deps.openAccount({ baseUrl: b.baseUrl, setupToken: b.setupToken }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "could not open account";
    // A sandbox refusal is a 409 (conflict with the org's local-only nature); everything else the
    // operator can act on - a bad token, an unreachable server - is a terse 400. Never a raw 500.
    const status = /sandbox/i.test(msg) ? 409 : 400;
    return json({ error: msg }, status);
  }
}
if (method === "GET" && deps.accountState && path === "/api/account") {
  return json(deps.accountState());
}
```

In `wiring.ts`, assemble `openAccount` and `accountState` from Task 7's `account`/`tokenProvider` and Tasks 2/6:

```ts
openAccount: account
  ? async ({ baseUrl, setupToken }) => {
      const result = await provision({ fetch: fetchImpl, baseUrl }, { setupToken, machineName: hostname() });
      account.save(baseUrl, result);
      const res = await attachOrg({ engine: sync, roots: config.roots, repos: result.repos, sandbox: config.sandbox ?? false });
      return { state: res.status === "needs-help" ? "needs-help" : "connected" };
    }
  : undefined,
accountState: () => {
  const a = account?.load();
  return a
    ? { state: "connected", operatorId: a.operatorId, companySlug: a.companySlug, remotes: a.repos }
    : { state: "local" };
},
```

(Use `os.hostname()` for `machineName`; add `sandbox?: boolean` to `ClientConfig`, populated from `org.sandbox` in `orgs/router.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/client/src/daemon/account-route.test.ts apps/client/src/daemon/daemon.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/daemon/daemon.ts apps/client/src/wiring.ts apps/client/src/daemon/account-route.test.ts
git commit -m "feat(daemon): POST/GET /api/account - open an account and report its state"
```

---

### Task 9: Per-root status on `GET /api/sync`

**Files:**
- Modify: `apps/client/src/sync/scheduler.ts` (`publishRoots` collapse at 227; expose the per-root map)
- Modify: `apps/client/src/wiring.ts` (`syncStatus` dep) and `apps/client/src/daemon/daemon.ts` (`GET /api/sync`)
- Test: `apps/client/src/sync/scheduler.test.ts` (extend), `apps/client/src/daemon/daemon.test.ts` (extend)

**Interfaces:**
- Consumes: the per-root `SyncResult[]` the scheduler already computes.
- Produces: the scheduler records the last per-root result map (`Record<string, SyncStatus>` keyed by dir) and exposes `perRoot(): Record<string, SyncStatus>`; wiring passes it as a new optional daemon dep `perRootStatus?: () => Record<string, string>`; `GET /api/sync` includes `perRoot` alongside `status` and `unsaved`.

> This is the most self-contained task and the safest to defer if scope must be trimmed — it adds no capability the "done-when" needs, only diagnosis. Keep it, but implement it last among the behavioural tasks.

- [ ] **Step 1: Write the failing test** (scheduler records per-root; daemon serializes)

```ts
// add to apps/client/src/sync/scheduler.test.ts
it("records the per-root status of the last publish", async () => {
  const engine = new FakeEngine();
  engine.publishResults = ["ok", "queued"];
  const { scheduler } = make({ engine, roots: ["/team", "/private"] });
  await scheduler.publishAll();
  expect(scheduler.perRoot()).toEqual({ "/team": "ok", "/private": "queued" });
});
```

```ts
// add to apps/client/src/daemon/daemon.test.ts (inside the /api/sync describe)
it("GET includes the per-root status map when wired", async () => {
  const { app } = makeDaemon({ syncStatus: () => "queued", perRootStatus: () => ({ "/team": "ok", "/private": "queued" }) });
  const body = await (await app(new Request("http://127.0.0.1/api/sync"))).json();
  expect(body.perRoot).toEqual({ "/team": "ok", "/private": "queued" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/client/src/sync/scheduler.test.ts apps/client/src/daemon/daemon.test.ts`
Expected: FAIL — `perRoot()` / `perRootStatus` absent.

- [ ] **Step 3: Implement**

In `scheduler.ts`, in `publishRoots` where `worstStatus(results)` is computed (line 227), also store a `Map<string,SyncStatus>` of `roots[i] → results[i]` on a private field, and add:
```ts
private lastPerRoot: Record<string, SyncStatus> = {};
perRoot(): Record<string, SyncStatus> { return { ...this.lastPerRoot }; }
```
Populate `lastPerRoot` from `roots`/`results` before returning. In `daemon.ts`, extend the `GET /api/sync` response:
```ts
return json({ status: deps.syncStatus?.() ?? "ok", unsaved: await unsavedCached(), ...(deps.perRootStatus ? { perRoot: deps.perRootStatus() } : {}) });
```
Add `perRootStatus?: () => Record<string, string>` to `DaemonDeps` and wire it to `scheduler.perRoot()`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run apps/client/src/sync/scheduler.test.ts apps/client/src/daemon/daemon.test.ts`
Expected: PASS (existing `/api/sync` assertions unaffected — `perRoot` is only present when the dep is wired).

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/sync/scheduler.ts apps/client/src/daemon/daemon.ts apps/client/src/wiring.ts apps/client/src/sync/scheduler.test.ts apps/client/src/daemon/daemon.test.ts
git commit -m "feat(sync): expose per-root status so the console can say which root is stuck"
```

---

### Task 10: Console — the paste-a-token field and the connected copy

**Files:**
- Modify: `apps/client/web/js/onboarding.js` (the "Team sync accounts are coming" copy)
- Modify: `apps/client/web/js/sync.js` (retire the `local` copy once connected)
- Test: `apps/client/src/daemon/console-render.test.ts` (the jsdom harness that loads the real bundle — extend it)

**Interfaces:**
- Consumes: `GET /api/account` (Task 8) and `POST /api/account`.
- Produces: an onboarding panel with a `baseUrl` field and a setup-token field whose submit POSTs `/api/account` and, on `{state:"connected"}`, refreshes the sync surface. Operator copy uses "connect", "save", "your company" — never `push`, `commit`, `token` is acceptable as "setup code" (prefer "setup code" in the label; "token" may appear once in a helper line). No `push`/`commit`/`branch`/`merge`/`diff` in operator copy.

- [ ] **Step 1: Write the failing test**

Extend `console-render.test.ts` (harness `console-harness.ts` already loads the real web bundle in jsdom). Add a case that stubs `GET /api/account` → `{state:"local"}` and asserts the onboarding panel renders a setup-code field (not the "coming" placeholder); and a case that stubs `{state:"connected", companySlug:"acme"}` and asserts the "staying on this machine" local copy is gone. Follow the existing fetch-stub pattern in that file. (Exact selectors: reuse the panel's existing container id; assert on visible text and the presence of an `<input>` for the code.)

```ts
// sketch — mirror the existing stub/assert style in console-render.test.ts
it("onboarding shows a setup-code field when the org is local, not a 'coming soon' placeholder", async () => {
  const dom = await renderConsole({ "/api/account": { state: "local" } /* plus the usual stubs */ });
  const panel = dom.window.document.querySelector("#onboarding")!;
  expect(panel.textContent).not.toMatch(/coming/i);
  expect(panel.querySelector("input")).toBeTruthy();
});

it("once connected, the sync surface drops the 'staying on this machine' local copy", async () => {
  const dom = await renderConsole({ "/api/account": { state: "connected", companySlug: "acme" }, "/api/sync": { status: "ok", unsaved: { files: 0, oldestAt: null, stale: false, connected: true } } });
  expect(dom.window.document.body.textContent).not.toMatch(/staying on this machine/i);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/client/src/daemon/console-render.test.ts`
Expected: FAIL — the placeholder copy is still present / no input field.

- [ ] **Step 3: Implement the web changes**

In `onboarding.js`: replace the placeholder block with a small form — a `baseUrl` input (prefilled/hint), a "setup code" input, and a Connect button. On submit, `fetch('/api/account', {method:'POST', body: JSON.stringify({baseUrl, setupToken})})`; on `state:"connected"` re-fetch the sync/account surfaces and hide the form; on a non-200 show the returned `error` inline. Use the existing plain-DOM idiom in the file (no ES modules — script-tag globals, matching the rest of `web/js`).

In `sync.js`: gate the `local`/"staying on this machine" copy on `GET /api/account` (or the `connected` flag already on `GET /api/sync`) so it disappears once connected. Keep all other dot/card behaviour from the manual-save work intact.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run apps/client/src/daemon/console-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/client/web/js/onboarding.js apps/client/web/js/sync.js apps/client/src/daemon/console-render.test.ts
git commit -m "feat(console): paste a setup code to connect an account; drop the local-only copy once connected"
```

---

### Task 11: The `[release-gate:no-token-on-disk]` invariant (+ per-org secrets key, + registry bump)

**Files:**
- Create: `apps/client/src/invariants/no-token-on-disk.test.ts`
- Modify: `apps/client/src/invariants/secrets.test.ts` (the fixture key at line 78)
- Modify: `apps/client/src/invariants/invariants-registry.test.ts` (`EXPECTED` at 12; `desc`/comment wording)

**Interfaces:**
- Consumes: `provision` (Task 2 — but drive it with an injected fetch that returns credentials pointing at local `file://` bare repos), `AccountStore`, `attachOrg`, `SyncEngine`, `gitAuthEnv`.
- Produces: a release-gate suite that opens an account end-to-end against injected fetch + `file://` bare repos, saves it, attaches, publishes, then greps the entire workspace tree, every `.git/config`, and `account.json` for the `xmachine_` prefix and finds nothing.

- [ ] **Step 1: Write the failing test**

```ts
// apps/client/src/invariants/no-token-on-disk.test.ts
// [release-gate:no-token-on-disk] After a complete account-open + sync, the machine token exists ONLY
// in the injected keychain - never in a working tree, a .git/config, a remote URL, or account.json.
// This is the invariant the GIT_CONFIG_* http.extraHeader approach exists to protect; a regression to
// a credential helper or a URL-embedded token must fail the build. It runs in the apps/client suite
// (not the cross-module smoke) so it executes on Windows, where the keychain/path/git differ most.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { AccountStore } from "../account/account-store.js";
import { attachOrg } from "../account/attach.js";
import { gitAuthEnv } from "../account/credentials.js";
import { SyncEngine } from "../sync/engine.js";

const TOKEN = "xmachine_" + "feedface".repeat(6);
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const git = (a: string[], cwd: string) => execFileSync("git", a, { cwd, env: ENV, encoding: "utf8" });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "buildex-notok-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("INVARIANT [release-gate:no-token-on-disk]: an opened account keeps its token off disk", () => {
  it("no file under the org - working tree, .git/config, or account.json - contains the machine token", async () => {
    // Bare remotes named as the server would name them.
    const bares: Record<string, string> = {};
    for (const name of ["core", "team-acme", "private-o1"]) {
      const b = join(root, `${name}.git`);
      git(["init", "--bare", "--initial-branch=main", b], root);
      bares[name] = `file://${b}`;
    }
    // Local org roots with real content.
    const orgDir = join(root, "org");
    const roots = ["core", "team", "private"].map((name) => {
      const dir = join(orgDir, "workspace", name);
      mkdirSync(dir, { recursive: true });
      git(["init", "--initial-branch=main", "."], dir);
      writeFileSync(join(dir, "doc.md"), `${name} content\n`);
      git(["add", "-A"], dir); git(["commit", "-m", "seed"], dir);
      return { name, dir };
    });

    const repos = { core: bares.core!, team: bares["team-acme"]!, private: bares["private-o1"]! };
    const keychain = new InMemoryKeychain();
    const store = new AccountStore({ orgId: "o1", orgDir, keychain });
    store.save("https://sync.test", { machineToken: TOKEN, refreshToken: "xrefresh_" + "1".repeat(48), repos });

    const engine = new SyncEngine({
      now: Date.now, actor: "t",
      auth: { headerEnv: () => gitAuthEnv(store.tokens()!.machineToken), onAuthError: async () => false },
    });
    const res = await attachOrg({ engine, roots, repos, sandbox: false });
    expect(res.status).toBe("connected");

    // The token is present in the keychain...
    expect(keychain.get("org:o1:machine-token")).toBe(TOKEN);
    // ...and NOWHERE on disk under the org dir (working trees, every .git/config, account.json).
    for (const file of walk(orgDir)) {
      const bytes = readFileSync(file);
      expect(bytes.includes(Buffer.from(TOKEN)), `token leaked into ${file}`).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/client/src/invariants/no-token-on-disk.test.ts`
Expected: FAIL — until Tasks 1-6 are in place it fails to import; once they are, it should PASS. To prove the gate has teeth, temporarily make `gitAuthEnv` return `{ GIT_CONFIG_COUNT: "0" }` and instead `git remote set-url origin` to a URL with the token embedded — confirm the test then FAILS — then revert. (Do this check once; do not commit the sabotage.)

- [ ] **Step 3: Update the registry and the secrets fixture**

`invariants-registry.test.ts:12`:
```ts
const EXPECTED = ["determinism", "gates", "no-token-on-disk", "permission-matrix", "secrets", "sync-safety"];
```
Update its `describe` text and header comment from "five" to "six" (both the line-1 comment and the `describe(...)` title at line 27).

`secrets.test.ts:78` — change the fake fixture key to the per-org form so the invariant reflects the real key convention (decision 3):
```ts
keychain.set("org:demo:machine-token", TOKEN);
```
(Leave the leak assertions below it as-is; they check the token value, not the key.)

- [ ] **Step 4: Run the full invariant gate**

Run: `task invariants`
Expected: PASS — the registry now expects six, the six tagged suites are found, and `no-token-on-disk` runs green in the client lane.

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/invariants/no-token-on-disk.test.ts apps/client/src/invariants/secrets.test.ts apps/client/src/invariants/invariants-registry.test.ts
git commit -m "test(invariant): [release-gate:no-token-on-disk] - an opened account keeps its token off disk"
```

---

## Documentation (fold into the last task's session, not a separate task)

- `docs/` gains one guide as the capability lands: `docs/connecting-an-account.md` — how an operator connects an org with a setup code, in operator language. Write it in the Task 10/11 session.
- No `infra/infrastructure.md` change: Phase 2 is client-only and adds no hosted infra. (The live deploy — Phase 1 Task 8 — carries its own infra entry when it lands.)

## Final gate

After Task 11, run the full `task ci` (secret-scan → test-collection-audit → typecheck → test) until green. The five — now six — invariant suites are release gates and cannot be skipped. Then use `superpowers:finishing-a-development-branch`.

## Self-Review (completed by the plan author)

- **Spec coverage:** every Phase 2 row in the spec's tables maps to a task — provision-client (T2), account-store (T3), token-provider (T4), credentials (T1), attach (T6), engine credential gap (T5), `syncReadonly`/`writableDirs` (already closed — Deviations #2), per-root status (T9), secrets key (T11), daemon routes (T8), UI (T10), the new release gate (T11). The two already-closed gaps are explicitly dropped with evidence.
- **Placeholder scan:** every code step carries real code or an exact signature + file:line; the two web/UI steps name the real bundle test harness (`console-render.test.ts` / `console-harness.ts`) rather than hand-waving "add a test".
- **Type consistency:** `ProvisionResult` (T2) flows unchanged into `AccountStore.save` (T3), `TokenProvider` (T4), `attachOrg.repos` (T6), and the daemon route (T8). `EngineAuth` (T5) is exactly the object wiring builds (T7) and the invariant test constructs (T11). Keychain keys `org:<orgId>:machine-token` / `:refresh-token` are identical in T3, T7, T11, and the updated secrets fixture.
- **Open item from the spec** (Fly volume sizing) is Phase 1/deploy, not Phase 2 — correctly out of scope here.
