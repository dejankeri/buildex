# Phase 1: Deployable Sync Server - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/sync` a process entrypoint, a container image, and a deploy target, so the already-built service actually runs on the public internet and a laptop can clone a repo from it.

**Architecture:** `apps/sync` today is a library with no `main`. Nothing reads `process.env`, nothing binds a port, and `infra/compose.yml` references a `Dockerfile` that does not exist. This plan adds three thin layers in strict dependency order - config parsing (pure), a composition root (wires the existing services), and a process entrypoint (signals and sockets) - then packages the result as a container and deploys it to Fly.io. **No existing behaviour changes.** Every route, permission check, and token rule already works and is already tested; this plan only gives them somewhere to run.

**Tech Stack:** TypeScript (NodeNext, `.js` import specifiers), Node 22 built-ins only, Vitest, Docker, Fly.io, Litestream → Cloudflare R2.

**Spec:** `docs/superpowers/specs/2026-07-21-sync-account-design.md` (Phase 1 section, decisions 6 and 7).

## Global Constraints

- **`apps/sync` has zero npm dependencies and zero devDependencies. Do not add any.** Everything uses Node 22 built-ins (`node:sqlite`, `node:crypto`, `node:http`, `node:child_process`). This is the property that makes the container tiny and the service self-hostable.
- Node `>=22` (root `package.json` `engines`). CI pins Node 22.
- All relative imports use **`.js` specifiers** (`./config.js`), never `.ts` and never extensionless - `tsconfig.base.json` sets `module: NodeNext`.
- `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`. Type-only imports must use `import type`. Indexing a `Record` yields `T | undefined`.
- **This repo is public under MIT.** No real hostnames, bucket names, keys, IDs, or costs in any tracked file. Placeholders only.
- `apps/sync` is deliberately excluded from the Windows CI lane. It is a Linux-only cloud service. Do not add Windows coverage for it.
- Every infra change lands in `infra/infrastructure.md` (topology + cost ledger + snapshot date) **in the same session**.
- Do not wire the automations `tickOnce` loop. It is out of scope (spec decision 7) and would queue runs nobody claims.
- Commit after every task. Run `task ci` before the final task's commit.

---

### Task 1: Config parsing

Pure environment parsing, separated from the entrypoint so the rules - what is required, what has a default, what is rejected - are testable without spawning a process or binding a port.

**Files:**
- Create: `apps/sync/src/config.ts`
- Test: `apps/sync/src/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SyncConfig` (`{ serviceKey: string; publicBaseUrl: string; dataDir: string; port: number }`), `readConfig(env: Record<string, string | undefined>): SyncConfig`, `ConfigError extends Error`, `MIN_SERVICE_KEY_LENGTH: number`. Tasks 2, 3 and 5 depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `apps/sync/src/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readConfig, ConfigError, MIN_SERVICE_KEY_LENGTH } from "./config.js";

const KEY = "k".repeat(MIN_SERVICE_KEY_LENGTH);

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    BUILDEX_SERVICE_KEY: KEY,
    BUILDEX_PUBLIC_BASE_URL: "https://sync.example.test",
    ...over,
  };
}

describe("readConfig", () => {
  it("reads a complete environment", () => {
    const c = readConfig(env({ BUILDEX_DATA_DIR: "/data", PORT: "9000" }));
    expect(c).toEqual({
      serviceKey: KEY,
      publicBaseUrl: "https://sync.example.test",
      dataDir: "/data",
      port: 9000,
    });
  });

  it("defaults the data dir and port", () => {
    const c = readConfig(env());
    expect(c.dataDir).toBe("/srv/buildex");
    expect(c.port).toBe(8080);
  });

  it("strips a trailing slash from the base URL so clone URLs never double up", () => {
    expect(readConfig(env({ BUILDEX_PUBLIC_BASE_URL: "https://sync.example.test/" })).publicBaseUrl).toBe(
      "https://sync.example.test",
    );
  });

  it("requires a service key", () => {
    expect(() => readConfig(env({ BUILDEX_SERVICE_KEY: undefined }))).toThrow(ConfigError);
    expect(() => readConfig(env({ BUILDEX_SERVICE_KEY: "   " }))).toThrow(/required/);
  });

  it("rejects a short service key - it guards company creation on the public internet", () => {
    expect(() => readConfig(env({ BUILDEX_SERVICE_KEY: "short" }))).toThrow(/at least/);
  });

  it("requires an absolute https base URL", () => {
    expect(() => readConfig(env({ BUILDEX_PUBLIC_BASE_URL: undefined }))).toThrow(/required/);
    expect(() => readConfig(env({ BUILDEX_PUBLIC_BASE_URL: "sync.example.test" }))).toThrow(/absolute URL/);
    expect(() => readConfig(env({ BUILDEX_PUBLIC_BASE_URL: "http://sync.example.test" }))).toThrow(/https/);
  });

  it("allows plain http on loopback so a local run needs no certificate", () => {
    expect(readConfig(env({ BUILDEX_PUBLIC_BASE_URL: "http://127.0.0.1:8080" })).publicBaseUrl).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("rejects a non-numeric or out-of-range port", () => {
    expect(() => readConfig(env({ PORT: "eighty" }))).toThrow(/PORT/);
    expect(() => readConfig(env({ PORT: "70000" }))).toThrow(/PORT/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test --workspace @buildex/sync -- config.test
```

Expected: FAIL — `Failed to resolve import "./config.js"`.

- [ ] **Step 3: Write the implementation**

Create `apps/sync/src/config.ts`:

```ts
// Process configuration for the sync service, parsed once at boot. Kept out of main.ts so the rules -
// what is required, what has a default, what is rejected - are unit-testable without spawning a
// process or binding a port. Fail fast and loudly: a service that boots with a weak service key is
// worse than one that refuses to boot, because the S2S surface is the only thing between the public
// internet and company creation.

export interface SyncConfig {
  serviceKey: string;
  publicBaseUrl: string;
  dataDir: string;
  port: number;
}

/** A shorter service key is a misconfiguration, not a valid deployment. */
export const MIN_SERVICE_KEY_LENGTH = 32;

export class ConfigError extends Error {}

export function readConfig(env: Record<string, string | undefined>): SyncConfig {
  const serviceKey = (env["BUILDEX_SERVICE_KEY"] ?? "").trim();
  if (!serviceKey) throw new ConfigError("BUILDEX_SERVICE_KEY is required");
  if (serviceKey.length < MIN_SERVICE_KEY_LENGTH) {
    throw new ConfigError(`BUILDEX_SERVICE_KEY must be at least ${MIN_SERVICE_KEY_LENGTH} characters`);
  }

  // Trailing slashes are stripped here so `${publicBaseUrl}/git/<repo>.git` can never double up.
  const rawBase = (env["BUILDEX_PUBLIC_BASE_URL"] ?? "").trim().replace(/\/+$/, "");
  if (!rawBase) throw new ConfigError("BUILDEX_PUBLIC_BASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    throw new ConfigError("BUILDEX_PUBLIC_BASE_URL must be an absolute URL");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !loopback) {
    throw new ConfigError("BUILDEX_PUBLIC_BASE_URL must be https (except on loopback)");
  }

  const dataDir = (env["BUILDEX_DATA_DIR"] ?? "/srv/buildex").trim();

  const rawPort = (env["PORT"] ?? "8080").trim();
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 0 and 65535, got "${rawPort}"`);
  }

  return { serviceKey, publicBaseUrl: rawBase, dataDir, port };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test --workspace @buildex/sync -- config.test
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/sync/src/config.ts apps/sync/src/config.test.ts
git commit -m "feat(sync): parse and validate process config

Fails fast on a missing or short service key and on a non-https public base
URL, because the S2S surface guards company creation on the public internet.
Kept separate from the entrypoint so the rules are testable without binding a
port."
```

---

### Task 2: Composition root

Wire the four existing services into a handler. Separated from `main.ts` so the wiring can be tested against a temp directory without sockets or signals - and so the SQLite close discipline that `ee770eb` fixed is asserted rather than assumed.

**Files:**
- Create: `apps/sync/src/server.ts`
- Test: `apps/sync/src/server.test.ts`

**Interfaces:**
- Consumes: `SyncConfig` from Task 1.
- Produces: `Services` (`{ handler: Handler; close: () => void }`) and `createServices(config: SyncConfig): Promise<Services>`. Task 3 depends on these exact names.

- [ ] **Step 1: Write the failing test**

Create `apps/sync/src/server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices, type Services } from "./server.js";
import type { SyncConfig } from "./config.js";

let dir: string;
let services: Services | undefined;

function config(over: Partial<SyncConfig> = {}): SyncConfig {
  return {
    serviceKey: "k".repeat(32),
    publicBaseUrl: "https://sync.example.test",
    dataDir: dir,
    port: 0,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-sync-server-"));
  services = undefined;
});

afterEach(() => {
  services?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("createServices", () => {
  it("creates the data layout and answers healthz", async () => {
    services = await createServices(config());

    expect(existsSync(join(dir, "control.db"))).toBe(true);
    expect(existsSync(join(dir, "repos"))).toBe(true);

    const res = await services.handler(new Request("http://sync.test/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("ensures the core repo exists at boot, before any operator provisions", async () => {
    services = await createServices(config());
    expect(existsSync(join(dir, "repos", "core.git"))).toBe(true);
  });

  it("creates the data dir when it does not exist yet (first boot on a fresh volume)", async () => {
    const fresh = join(dir, "nested", "srv");
    services = await createServices(config({ dataDir: fresh }));
    expect(existsSync(join(fresh, "control.db"))).toBe(true);
  });

  it("wires the service key, so an S2S call with the wrong key is rejected", async () => {
    services = await createServices(config());
    const res = await services.handler(
      new Request("http://sync.test/s2s/companies", {
        method: "POST",
        headers: { "x-service-key": "wrong", "content-type": "application/json" },
        body: JSON.stringify({ id: "c1", slug: "acme", name: "Acme" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("closes both SQLite stores, so nothing holds a handle after shutdown", async () => {
    const s = await createServices(config());
    s.close();
    // Closing twice must not throw - shutdown can race a signal with an error path.
    expect(() => s.close()).not.toThrow();
    services = undefined;
  });

  it("reopens an existing data dir without losing state", async () => {
    const first = await createServices(config());
    await first.handler(
      new Request("http://sync.test/s2s/companies", {
        method: "POST",
        headers: { "x-service-key": "k".repeat(32), "content-type": "application/json" },
        body: JSON.stringify({ id: "c1", slug: "acme", name: "Acme" }),
      }),
    );
    first.close();

    services = await createServices(config());
    const res = await services.handler(
      new Request("http://sync.test/s2s/operators", {
        method: "POST",
        headers: { "x-service-key": "k".repeat(32), "content-type": "application/json" },
        body: JSON.stringify({ id: "o1", companyId: "c1", email: "a@example.test" }),
      }),
    );
    // The operator's foreign key to company c1 only resolves if the first boot's state persisted.
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test --workspace @buildex/sync -- server.test
```

Expected: FAIL — `Failed to resolve import "./server.js"`.

- [ ] **Step 3: Write the implementation**

Create `apps/sync/src/server.ts`:

```ts
// The composition root: turns a validated config into a live request handler by wiring the four
// services that already exist. It deliberately knows nothing about sockets, signals, or process exit -
// that is main.ts - so the wiring stays testable in-process against a temp directory.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlPlaneStore } from "./store/store.js";
import { ScheduleStore } from "./automations/schedule-store.js";
import { EmbeddedGitService } from "./git/service.js";
import { ProvisioningService } from "./provisioning/service.js";
import { createApp, type Handler } from "./http/app.js";
import type { SyncConfig } from "./config.js";

export interface Services {
  handler: Handler;
  /** Release every SQLite handle. Idempotent: shutdown can race a signal with an error path. */
  close: () => void;
}

export async function createServices(config: SyncConfig): Promise<Services> {
  const reposRoot = join(config.dataDir, "repos");
  mkdirSync(reposRoot, { recursive: true }); // also creates dataDir - first boot on a fresh volume

  const store = new ControlPlaneStore(join(config.dataDir, "control.db"));
  const schedules = new ScheduleStore(join(config.dataDir, "schedules.db"));
  const git = new EmbeddedGitService({ reposRoot });
  const provisioning = new ProvisioningService({ store, git, idFactory: () => randomUUID() });

  // `ensureCoreRepo` is documented as "call at boot": core is the one repo not created by a
  // provision, so without this the first operator's clone of core would 404.
  await provisioning.ensureCoreRepo();

  const handler = createApp({
    store,
    provisioning,
    git,
    schedules,
    serviceKey: config.serviceKey,
    publicBaseUrl: config.publicBaseUrl,
  });

  // BOTH stores must close. Leaving either open is what blocked cleanup before ee770eb.
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    store.close();
    schedules.close();
  };

  return { handler, close };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test --workspace @buildex/sync -- server.test
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/sync/src/server.ts apps/sync/src/server.test.ts
git commit -m "feat(sync): composition root wiring config to a live handler

Creates the data layout, opens both SQLite stores, ensures the core repo at
boot (without it the first operator's core clone 404s), and returns an
idempotent close that releases both handles - the discipline ee770eb fixed."
```

---

### Task 3: Entrypoint and graceful shutdown

The process layer: bind a socket, handle signals, exit with a useful code. `installShutdown` is a separate exported function so signal behaviour is tested by invoking the handler directly rather than by killing the test runner.

**Files:**
- Create: `apps/sync/src/main.ts`
- Test: `apps/sync/src/main.test.ts`

**Interfaces:**
- Consumes: `readConfig`, `ConfigError` (Task 1); `createServices`, `Services` (Task 2); `listen` from `./http/node-server.js` (exists: returns `{ server, port, close }` where `close` returns `Promise<void>`).
- Produces: `start(env): Promise<{ port: number; stop: () => Promise<void> }>` and `installShutdown(stop, on): void`. Task 5's container entrypoint runs this module.

- [ ] **Step 1: Write the failing test**

Create `apps/sync/src/main.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, installShutdown } from "./main.js";

let dir: string;
let stop: (() => Promise<void>) | undefined;

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    BUILDEX_SERVICE_KEY: "k".repeat(32),
    BUILDEX_PUBLIC_BASE_URL: "http://127.0.0.1:8080",
    BUILDEX_DATA_DIR: dir,
    PORT: "0", // ephemeral - never collide with a real service on a dev machine
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-sync-main-"));
  stop = undefined;
});

afterEach(async () => {
  await stop?.();
  rmSync(dir, { recursive: true, force: true });
});

describe("start", () => {
  it("binds a port and serves healthz over a real socket", async () => {
    const started = await start(env());
    stop = started.stop;

    expect(started.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${started.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("propagates a config error instead of booting half-configured", async () => {
    await expect(start(env({ BUILDEX_SERVICE_KEY: undefined }))).rejects.toThrow(/BUILDEX_SERVICE_KEY/);
  });

  it("stop is idempotent", async () => {
    const started = await start(env());
    await started.stop();
    await expect(started.stop()).resolves.toBeUndefined();
    stop = undefined;
  });
});

describe("installShutdown", () => {
  it("registers both signals and calls stop exactly once when either fires", async () => {
    const handlers = new Map<string, () => void>();
    const on = vi.fn((signal: string, handler: () => void) => {
      handlers.set(signal, handler);
    });
    const stopFn = vi.fn(async () => {});

    installShutdown(stopFn, on);

    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);

    handlers.get("SIGTERM")!();
    handlers.get("SIGINT")!();
    await vi.waitFor(() => expect(stopFn).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test --workspace @buildex/sync -- main.test
```

Expected: FAIL — `Failed to resolve import "./main.js"`.

- [ ] **Step 3: Write the implementation**

Create `apps/sync/src/main.ts`:

```ts
// The process entrypoint - the only file in apps/sync that knows about env, sockets, signals and
// exit codes. Everything it needs is already built: config.ts validates, server.ts wires,
// node-server.ts binds. `start` is exported and returns a handle so the whole boot path is testable
// in-process on an ephemeral port; the bottom of the file is the only part that touches `process`.
import { readConfig } from "./config.js";
import { createServices } from "./server.js";
import { listen } from "./http/node-server.js";

export interface Started {
  port: number;
  /** Stop serving and release every handle. Idempotent. */
  stop: () => Promise<void>;
}

export async function start(env: Record<string, string | undefined>): Promise<Started> {
  const config = readConfig(env); // throws ConfigError - a half-configured boot is worse than none
  const services = await createServices(config);
  const bound = await listen(services.handler, { port: config.port, host: "0.0.0.0" });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await bound.close(); // force-closes keep-alive sockets; git and undici both hold them open
    services.close();
  };

  return { port: bound.port, stop };
}

type SignalRegistrar = (signal: string, handler: () => void) => void;

/** Wire SIGTERM/SIGINT to a single graceful stop. `on` is injected so this is testable without
 *  installing real handlers on the test runner's own process. */
export function installShutdown(stop: () => Promise<void>, on: SignalRegistrar): void {
  let shuttingDown = false;
  const handler = (): void => {
    if (shuttingDown) return; // a second Ctrl-C must not race two closes
    shuttingDown = true;
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  on("SIGTERM", handler);
  on("SIGINT", handler);
}

// Run only when executed directly (`node dist/main.js`), never when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start(process.env)
    .then((started) => {
      // Never log the service key or any token - only the shape of the boot.
      console.log(`[sync] listening on 0.0.0.0:${started.port}`);
      installShutdown(started.stop, (signal, h) => {
        process.on(signal, h);
      });
    })
    .catch((err: unknown) => {
      console.error(`[sync] failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test --workspace @buildex/sync -- main.test
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/sync/src/main.ts apps/sync/src/main.test.ts
git commit -m "feat(sync): process entrypoint with graceful shutdown

start() is exported and returns a handle, so the whole boot path is tested
in-process on an ephemeral port; only the direct-execution guard at the bottom
touches process. Signal registration is injected so shutdown is tested without
installing handlers on the test runner."
```

---

### Task 4: Build output

`tsc` currently only typechecks (`--noEmit`). The container needs real JavaScript, and test files must not ship in the image.

**Files:**
- Create: `apps/sync/tsconfig.build.json`
- Modify: `apps/sync/package.json` (add a `build` script)
- Test: `apps/sync/src/build.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 (the emitted entrypoint is `dist/main.js`).
- Produces: `npm run build --workspace @buildex/sync` emitting to `apps/sync/dist/`, with `dist/main.js` as the container's entrypoint. Task 5 depends on that exact path.

- [ ] **Step 1: Write the failing test**

Create `apps/sync/src/build.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkgRoot, "dist");

describe("build", () => {
  it("emits a runnable entrypoint and ships no test files", () => {
    rmSync(dist, { recursive: true, force: true });

    execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: pkgRoot, stdio: "pipe" });

    expect(existsSync(join(dist, "main.js"))).toBe(true);
    expect(existsSync(join(dist, "http", "app.js"))).toBe(true);
    expect(existsSync(join(dist, "store", "store.js"))).toBe(true);

    // Tests must never reach the image: they pull in vitest, which is not installed at runtime.
    const emitted = readdirSync(dist, { recursive: true, encoding: "utf8" });
    expect(emitted.filter((f) => f.includes(".test."))).toEqual([]);
  }, 120_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test --workspace @buildex/sync -- build.test
```

Expected: FAIL — tsc exits non-zero, `File 'tsconfig.build.json' not found`.

- [ ] **Step 3: Write the implementation**

Create `apps/sync/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "//": "Emit config for the container image. The default tsconfig is --noEmit (typecheck only); this one emits to dist/ and excludes tests, which would otherwise pull vitest into a runtime with no node_modules at all.",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "declaration": false,
    "sourceMap": true
  },
  "exclude": ["**/*.test.ts"]
}
```

Modify `apps/sync/package.json` — add `build` to `scripts`:

```json
{
  "name": "@buildex/sync",
  "version": "0.1.1",
  "private": true,
  "description": "@buildex/sync - the thin cloud service - identity, git hosting, seats",
  "license": "MIT",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test --workspace @buildex/sync -- build.test
node apps/sync/dist/main.js
```

Expected: the test PASSES (1 test). The `node` command prints `[sync] failed to start: BUILDEX_SERVICE_KEY is required` and exits 1 — which proves the emitted entrypoint runs and validates config. `dist/` is already covered by `.gitignore:6`.

- [ ] **Step 5: Commit**

```bash
git add apps/sync/tsconfig.build.json apps/sync/package.json apps/sync/src/build.test.ts
git commit -m "build(sync): emit dist/ for the container image

The default tsconfig is typecheck-only. This adds an emit config that excludes
tests - they would pull vitest into a runtime image that has no node_modules at
all, since apps/sync has zero dependencies by design."
```

---

### Task 5: Container image

Multi-stage build. The runtime stage carries no `node_modules` at all, because `apps/sync` has zero dependencies - only the emitted JavaScript, `git`, and `litestream`.

**Files:**
- Create: `apps/sync/Dockerfile`
- Create: `.dockerignore` (**repository root**, not `apps/sync/`)
- Test: manual verification (documented below; Docker is not available in the CI lanes).

**Interfaces:**
- Consumes: `dist/main.js` from Task 4.
- Produces: an image whose entrypoint is `litestream replicate -exec "node /app/dist/main.js"`, listening on `$PORT` (default 8080), with state under `/srv/buildex`. Task 6 deploys it.

**Build context is the repository root, not `apps/sync`** — `tsc` is hoisted to the root `node_modules`, so the build stage needs the root manifests. Every consumer must pass `-f apps/sync/Dockerfile` with the root as context.

- [ ] **Step 1: Write the .dockerignore**

Create `.dockerignore` **at the repository root**. Docker reads `.dockerignore` from the build
context root, and the context here is the repo root — a file at `apps/sync/.dockerignore` would be
silently ignored, and the whole repo (including a `node_modules` containing Electron) would be sent
as build context.

```
node_modules
**/node_modules
**/dist
.git
apps/client
apps/site
apps/connectors
apps/toolkit
packs
docs
scripts
infra/.env
*.log
```

`infra/litestream.yml` must stay out of the ignore list — the runtime stage copies it.

- [ ] **Step 1b: Verify the context shrank**

```bash
docker build -f apps/sync/Dockerfile -t buildex-sync . 2>&1 | head -3
```

Expected: the first line reads roughly `transferring context: <a few hundred KB>`, not hundreds of
megabytes. If it is large, the `.dockerignore` is in the wrong place.

- [ ] **Step 2: Write the Dockerfile**

Create `apps/sync/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
#
# The sync service image. Two properties drive every choice here:
#   1. apps/sync has ZERO npm dependencies, so the runtime stage carries no node_modules at all -
#      just emitted JavaScript, the git binary, and litestream.
#   2. It serves git smart-HTTP by spawning the real `git http-backend`, so `git` is a hard runtime
#      requirement, not a build-time one.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT:
#   docker build -f apps/sync/Dockerfile -t buildex-sync .

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

# Install the compiler directly rather than running a workspace `npm ci`: the root install would
# pull Electron for apps/client, which this image will never run. Versions track the root manifest.
RUN npm install -g typescript@5.7 @types/node@22

COPY apps/sync/tsconfig.json apps/sync/tsconfig.build.json apps/sync/package.json ./apps/sync/
COPY tsconfig.base.json ./
COPY apps/sync/src ./apps/sync/src

WORKDIR /app/apps/sync
RUN tsc -p tsconfig.build.json

# ---------- runtime ----------
FROM node:22-alpine AS runtime

# git: required at runtime - the service spawns `git http-backend` and `git init --bare`.
# ca-certificates: litestream needs TLS to reach object storage.
RUN apk add --no-cache git ca-certificates

# Litestream wraps the node process (see ENTRYPOINT): on a Fly machine there is one container, so it
# cannot be a compose sidecar. Wrapping also gives restore-before-serve ordering on a cold start.
ARG LITESTREAM_VERSION=0.3.13
RUN wget -qO /tmp/litestream.tar.gz \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
    && tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz litestream \
    && rm /tmp/litestream.tar.gz

WORKDIR /app
COPY --from=build /app/apps/sync/dist ./dist
COPY infra/litestream.yml /etc/litestream.yml

ENV NODE_ENV=production \
    BUILDEX_DATA_DIR=/srv/buildex \
    PORT=8080
EXPOSE 8080
VOLUME ["/srv/buildex"]

ENTRYPOINT ["litestream", "replicate", "-config", "/etc/litestream.yml", "-exec", "node /app/dist/main.js"]
```

- [ ] **Step 3: Build the image**

```bash
docker build -f apps/sync/Dockerfile -t buildex-sync .
```

Expected: builds successfully. Confirm the runtime stage has no `node_modules`:

```bash
docker run --rm buildex-sync sh -c "ls /app && node --version && git --version && litestream version"
```

Expected: `dist` only under `/app`, Node v22.x, a git version, and a litestream version.

- [ ] **Step 4: Run the container and verify it serves**

```bash
docker run --rm -d --name sync-check \
  -e BUILDEX_SERVICE_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n') \
  -e BUILDEX_PUBLIC_BASE_URL=http://127.0.0.1:8080 \
  -e LITESTREAM_BUCKET=dev -e LITESTREAM_ENDPOINT=http://127.0.0.1:1 \
  -p 8080:8080 buildex-sync
sleep 3
curl -sS http://127.0.0.1:8080/healthz
docker logs sync-check
docker rm -f sync-check
```

Expected: `{"ok":true}` from curl, and `[sync] listening on 0.0.0.0:8080` in the logs. Litestream will log replication errors against the unreachable dev endpoint — that is expected here and does not stop the service.

- [ ] **Step 5: Commit**

```bash
git add apps/sync/Dockerfile .dockerignore
git commit -m "build(sync): container image with git and litestream

Runtime stage carries no node_modules - apps/sync has zero dependencies, so the
image is emitted JavaScript plus the git binary it spawns for smart-HTTP.
Litestream is the entrypoint wrapping node rather than a sidecar: a Fly machine
runs one container, and wrapping gives restore-before-serve on a cold start.

Build context is the repo root (tsc is hoisted there), so consumers must pass
-f apps/sync/Dockerfile with . as the context."
```

---

### Task 6: Operator onboarding script

Without this, the paste-a-token front door has nothing to paste. A founder tool that creates a company and operator, then mints a setup token against a running service.

**Files:**
- Create: `scripts/mint-setup-token.ts`
- Test: `apps/sync/src/onboarding-flow.test.ts`

**Interfaces:**
- Consumes: the running service's `/s2s/companies`, `/s2s/operators`, `/s2s/setup-tokens` routes (all exist).
- Produces: `mintSetupToken(deps)` — an injectable-fetch function the test drives, plus a CLI wrapper. Phase 2 consumes the printed setup token.

`scripts/**/*.ts` is already covered by `tsconfig.scripts.json`, so `task typecheck:scripts` picks this up with no config change.

- [ ] **Step 1: Write the failing test**

Create `apps/sync/src/onboarding-flow.test.ts` — it drives the real handler, proving the sequence the script performs actually works end to end:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices, type Services } from "./server.js";

const KEY = "k".repeat(32);
let dir: string;
let services: Services;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "buildex-onboard-"));
  services = await createServices({
    serviceKey: KEY,
    publicBaseUrl: "https://sync.example.test",
    dataDir: dir,
    port: 0,
  });
});

afterEach(() => {
  services.close();
  rmSync(dir, { recursive: true, force: true });
});

function s2s(path: string, body: unknown): Request {
  return new Request(`http://sync.test${path}`, {
    method: "POST",
    headers: { "x-service-key": KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("founder onboarding sequence", () => {
  it("creates a company and operator, then mints a usable setup token", async () => {
    expect((await services.handler(s2s("/s2s/companies", { id: "c1", slug: "acme", name: "Acme" }))).status).toBe(201);
    expect(
      (await services.handler(s2s("/s2s/operators", { id: "o1", companyId: "c1", email: "a@example.test" }))).status,
    ).toBe(201);

    const minted = await services.handler(s2s("/s2s/setup-tokens", { operatorId: "o1" }));
    expect(minted.status).toBe(200);
    const { setupToken } = (await minted.json()) as { setupToken: string };
    expect(setupToken).toMatch(/^xsetup_/);

    // The whole point of the token: it provisions, and the clone URLs use the configured base URL.
    const provisioned = await services.handler(
      new Request("http://sync.test/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupToken, machineName: "laptop" }),
      }),
    );
    expect(provisioned.status).toBe(200);
    const creds = (await provisioned.json()) as { repos: { core: string; team: string; private: string } };
    expect(creds.repos.core).toBe("https://sync.example.test/git/core.git");
    expect(creds.repos.team).toBe("https://sync.example.test/git/team-acme.git");
  });

  it("rejects the whole sequence without the service key", async () => {
    const res = await services.handler(
      new Request("http://sync.test/s2s/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "c1", slug: "acme", name: "Acme" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails or passes**

```bash
npm run test --workspace @buildex/sync -- onboarding-flow.test
```

Expected: PASS (it exercises existing routes through Task 2's composition root). If the clone-URL assertions fail, read the actual URL shape out of the failure and correct the expectation to match `withCloneUrls` in `apps/sync/src/http/app.ts` — the route is the source of truth, not this plan.

- [ ] **Step 3: Write the script**

Create `scripts/mint-setup-token.ts`:

```ts
#!/usr/bin/env npx tsx
// Founder tool: onboard an operator against a running sync service and print their setup token.
// This is the other half of the paste-a-token front door - without it there is nothing to paste.
//
//   npx tsx scripts/mint-setup-token.ts --base-url https://<host> --onboard \
//     --company-slug acme --company-name "Acme Labs" --email operator@example.test
//
//   npx tsx scripts/mint-setup-token.ts --base-url https://<host> --operator-id <id>
//
// The service key is read from BUILDEX_SERVICE_KEY - never passed as an argument, which would put it
// in the shell history and the process list.
import { randomUUID } from "node:crypto";

export interface MintDeps {
  baseUrl: string;
  serviceKey: string;
  fetchImpl: typeof fetch;
}

async function s2s(deps: MintDeps, path: string, body: unknown): Promise<unknown> {
  const res = await deps.fetchImpl(`${deps.baseUrl}${path}`, {
    method: "POST",
    headers: { "x-service-key": deps.serviceKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Create a company + operator, then mint their setup token. Returns the token. */
export async function onboard(
  deps: MintDeps,
  opts: { companySlug: string; companyName: string; email: string },
): Promise<{ companyId: string; operatorId: string; setupToken: string }> {
  const companyId = `co_${randomUUID()}`;
  const operatorId = `op_${randomUUID()}`;
  await s2s(deps, "/s2s/companies", { id: companyId, slug: opts.companySlug, name: opts.companyName });
  await s2s(deps, "/s2s/operators", { id: operatorId, companyId, email: opts.email });
  const { setupToken } = (await s2s(deps, "/s2s/setup-tokens", { operatorId })) as { setupToken: string };
  return { companyId, operatorId, setupToken };
}

/** Mint a fresh setup token for an operator who already exists (a second machine, or a re-issue). */
export async function mintForOperator(deps: MintDeps, operatorId: string): Promise<string> {
  const { setupToken } = (await s2s(deps, "/s2s/setup-tokens", { operatorId })) as { setupToken: string };
  return setupToken;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const baseUrl = (arg("base-url") ?? "").replace(/\/+$/, "");
  const serviceKey = process.env["BUILDEX_SERVICE_KEY"] ?? "";
  if (!baseUrl) throw new Error("--base-url is required");
  if (!serviceKey) throw new Error("BUILDEX_SERVICE_KEY must be set in the environment");

  const deps: MintDeps = { baseUrl, serviceKey, fetchImpl: fetch };

  if (process.argv.includes("--onboard")) {
    const companySlug = arg("company-slug");
    const companyName = arg("company-name");
    const email = arg("email");
    if (!companySlug || !companyName || !email) {
      throw new Error("--onboard requires --company-slug, --company-name and --email");
    }
    const out = await onboard(deps, { companySlug, companyName, email });
    console.log(`company:  ${out.companyId}`);
    console.log(`operator: ${out.operatorId}`);
    console.log(`\nsetup token (one-time, expires in 10 minutes):\n${out.setupToken}`);
    return;
  }

  const operatorId = arg("operator-id");
  if (!operatorId) throw new Error("pass --onboard, or --operator-id <id> to re-issue");
  console.log(await mintForOperator(deps, operatorId));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

- [ ] **Step 4: Verify the script typechecks and the flow test passes**

```bash
npx tsc --noEmit -p tsconfig.scripts.json
npm run test --workspace @buildex/sync -- onboarding-flow.test
bash scripts/secret-scan.sh
```

Expected: no typecheck output, tests PASS, `secret-scan OK`.

- [ ] **Step 5: Commit**

```bash
git add scripts/mint-setup-token.ts apps/sync/src/onboarding-flow.test.ts
git commit -m "feat(sync): founder tool to onboard an operator and mint a setup token

The other half of the paste-a-token front door. Reads the service key from the
environment rather than argv, so it never reaches shell history or the process
list. The accompanying test drives the real handler through the exact sequence
the script performs, including that the minted token provisions and that clone
URLs use the configured public base URL."
```

---

### Task 7: Deploy configuration

Fly.toml, the compose fixes the spec calls for, Litestream retargeted at R2, Taskfile entries, and the infrastructure ledger — all one deliverable, because none of them is independently reviewable.

**Files:**
- Create: `infra/fly.toml`
- Modify: `infra/compose.yml`
- Modify: `infra/litestream.yml`
- Modify: `Taskfile.yml`
- Modify: `infra/infrastructure.md`
- Delete: `infra/Caddyfile` (Fly terminates TLS; compose keeps its own proxy-free shape)

- [ ] **Step 1: Create infra/fly.toml**

```toml
# buildex sync on Fly.io. PUBLIC REPO - placeholders only; the real app name and region live in the
# private infra notes and are passed at deploy time.
#
# Deploy from the REPOSITORY ROOT so the build context includes the hoisted toolchain:
#   fly deploy --config infra/fly.toml --dockerfile apps/sync/Dockerfile
#
# Secrets are set once, out of band, and never appear here:
#   fly secrets set BUILDEX_SERVICE_KEY=... BUILDEX_PUBLIC_BASE_URL=https://<host> \
#     LITESTREAM_BUCKET=... LITESTREAM_ENDPOINT=... \
#     LITESTREAM_ACCESS_KEY_ID=... LITESTREAM_SECRET_ACCESS_KEY=...

app = "buildex-sync-REPLACE"
primary_region = "REPLACE"

[build]
  dockerfile = "apps/sync/Dockerfile"

[env]
  BUILDEX_DATA_DIR = "/srv/buildex"
  PORT = "8080"

# One volume holds BOTH control.db and repos/. They must stay on the same filesystem: SQLite in WAL
# mode is unsafe on network storage, and splitting them would buy nothing while doubling the ways a
# restore can half-succeed.
[[mounts]]
  source = "buildex_data"
  destination = "/srv/buildex"

[http_service]
  internal_port = 8080
  force_https = true
  # A single-writer SQLite + git host is inherently single-node: never let Fly start a second machine.
  auto_stop_machines = false
  auto_start_machines = false
  min_machines_running = 1

  [http_service.concurrency]
    type = "requests"
    # Git pushes are long and bursty; the default soft limit would shed them under normal use.
    soft_limit = 50
    hard_limit = 100

[[http_service.checks]]
  grace_period = "10s"
  interval = "30s"
  method = "GET"
  path = "/healthz"
  timeout = "5s"
```

- [ ] **Step 2: Retarget Litestream at R2**

Replace `infra/litestream.yml` with:

```yaml
# Litestream - continuous replication of the sync control database to object storage.
# Runs as the container ENTRYPOINT wrapping the node process (see apps/sync/Dockerfile): a Fly
# machine runs one container, so it cannot be a compose sidecar, and wrapping gives
# restore-before-serve ordering on a cold start.
#
# Target is Cloudflare R2 (S3-compatible, zero egress). Bucket, endpoint and credentials come from
# the environment at deploy time - public repo, placeholders only.
dbs:
  - path: /srv/buildex/control.db
    replicas:
      - type: s3
        bucket: ${LITESTREAM_BUCKET:-buildex-backups-REPLACE}
        path: control.db
        endpoint: ${LITESTREAM_ENDPOINT:-https://REPLACE.r2.cloudflarestorage.com}
        region: auto
        # Restore onto a clean machine with:
        #   litestream restore -config /etc/litestream.yml -o /srv/buildex/control.db /srv/buildex/control.db
        # then run the rehearsed restore drill (apps/sync restore-drill) before serving traffic.
```

- [ ] **Step 3: Fix compose and drop Caddy**

Replace the `services:` block of `infra/compose.yml` so it describes the **local development** stack only:

```yaml
# buildex sync - LOCAL DEVELOPMENT stack. Production runs on Fly.io (infra/fly.toml), which
# terminates TLS and runs one container, so there is no reverse proxy and no litestream sidecar
# here either - the image's own entrypoint wraps litestream (see apps/sync/Dockerfile).
#
# PUBLIC REPO - no live values. Real hosts and keys live outside this repo and are supplied via an
# untracked infra/.env.
#
# Build context is the repository root: tsc is hoisted there.
services:
  sync:
    build:
      context: ..
      dockerfile: apps/sync/Dockerfile
    restart: unless-stopped
    environment:
      - BUILDEX_SERVICE_KEY=${BUILDEX_SERVICE_KEY:?set in infra/.env}
      - BUILDEX_PUBLIC_BASE_URL=${BUILDEX_PUBLIC_BASE_URL:-http://127.0.0.1:8080}
      - BUILDEX_DATA_DIR=/srv/buildex
      - LITESTREAM_BUCKET=${LITESTREAM_BUCKET:-dev}
      - LITESTREAM_ENDPOINT=${LITESTREAM_ENDPOINT:-http://127.0.0.1:1}
    volumes:
      - buildex_data:/srv/buildex
    ports:
      - "8080:8080"

volumes:
  buildex_data:
```

Then remove the now-unused proxy config:

```bash
git rm infra/Caddyfile
```

- [ ] **Step 4: Update the Taskfile**

In `Taskfile.yml`, replace the `deploy:plan` and `deploy` tasks and add the mint task:

```yaml
  mint-setup-token:
    desc: "Onboard an operator and print a one-time setup token (needs BUILDEX_SERVICE_KEY)"
    cmds:
      - npx tsx scripts/mint-setup-token.ts {{.CLI_ARGS}}

  deploy:plan:
    desc: "Dry-run: build the sync image and show what would deploy (no side effects)"
    cmds:
      - docker build -f apps/sync/Dockerfile -t buildex-sync .
      - fly deploy --config infra/fly.toml --dockerfile apps/sync/Dockerfile --build-only
      - echo "- dry-run only. Run 'task deploy' to apply (gated)."

  deploy:
    desc: "Deploy the sync service to Fly (gated - dry-run runs first, then asks before applying)"
    prompt: "Apply this deploy to the sync service?"
    deps: [deploy:plan]
    cmds:
      - fly deploy --config infra/fly.toml --dockerfile apps/sync/Dockerfile
```

- [ ] **Step 5: Update the infrastructure ledger**

In `infra/infrastructure.md`, replace the "Deploy stack (authored, not yet live)" section and update the snapshot date to `2026-07-21`:

```markdown
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
```

- [ ] **Step 6: Verify the whole gate passes**

```bash
task ci
```

Expected: `secret-scan OK`, test-collection-audit clean, typechecks clean, all suites pass, invariants pass, smoke passes.

- [ ] **Step 7: Commit**

```bash
git add infra/fly.toml infra/compose.yml infra/litestream.yml infra/infrastructure.md Taskfile.yml
git add -u infra/Caddyfile
git commit -m "infra: deploy sync to Fly, drop Caddy, retarget litestream at R2

Fly terminates TLS and runs one container, so the reverse proxy and the
litestream sidecar both leave the production path - litestream becomes the
image entrypoint instead. compose.yml is now the local development stack only.

Records why Fargate is not an option: control.db is SQLite in WAL mode and
SQLite locking is unsafe on network filesystems, which rules out Fargate+EFS -
the only way Fargate gets persistence. Written down so nobody later
'simplifies' onto EFS.

auto_stop_machines is off and min_machines_running is 1 deliberately: a
single-writer SQLite + git host is inherently single-node.

Repo snapshots remain outstanding and are called out in the ledger rather than
quietly assumed."
```

---

### Task 8: Live verification

The deploy is only real if a laptop can clone from it. This task has no code — it is the acceptance gate for the phase.

**Files:** none.

- [ ] **Step 1: Create the Fly app and volume**

```bash
fly apps create <app-name>
fly volumes create buildex_data --size 10 --region <region> --app <app-name>
```

Record the chosen app name and region in the private infra notes, **not** in this repo.

- [ ] **Step 2: Set secrets**

```bash
fly secrets set --app <app-name> \
  BUILDEX_SERVICE_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  BUILDEX_PUBLIC_BASE_URL="https://<app-name>.fly.dev" \
  LITESTREAM_BUCKET="<bucket>" \
  LITESTREAM_ENDPOINT="https://<account>.r2.cloudflarestorage.com" \
  LITESTREAM_ACCESS_KEY_ID="<key>" \
  LITESTREAM_SECRET_ACCESS_KEY="<secret>"
```

- [ ] **Step 3: Deploy**

```bash
task deploy
```

Expected: the prompt appears, the build succeeds, and the health check passes.

- [ ] **Step 4: Verify health over TLS**

```bash
curl -sS https://<app-name>.fly.dev/healthz
```

Expected: `{"ok":true}`.

- [ ] **Step 5: Verify the acceptance criterion — a real clone**

```bash
export BUILDEX_SERVICE_KEY=<the key set above>
npx tsx scripts/mint-setup-token.ts --base-url https://<app-name>.fly.dev --onboard \
  --company-slug acme --company-name "Acme Labs" --email you@example.test
```

Take the printed setup token and provision a machine credential:

```bash
curl -sS -X POST https://<app-name>.fly.dev/provision \
  -H 'content-type: application/json' \
  -d '{"setupToken":"<token>","machineName":"laptop"}'
```

Then clone with the returned machine token as the HTTP Basic password:

```bash
git clone https://x:<machineToken>@<app-name>.fly.dev/git/team-acme.git /tmp/team-check
cd /tmp/team-check && git commit --allow-empty -m "hello" && git push origin HEAD:main
```

Expected: the clone succeeds (empty repo warning is normal) and the push succeeds.

Then confirm the permission matrix holds in production:

```bash
git clone https://x:<machineToken>@<app-name>.fly.dev/git/core.git /tmp/core-check
cd /tmp/core-check && git commit --allow-empty -m "nope" && git push origin HEAD:main
```

Expected: the clone succeeds (core is readable) and **the push is rejected** — core is read-only by matrix.

- [ ] **Step 6: Record the result**

Append the verified date to the `infra/infrastructure.md` snapshot line and commit:

```bash
git add infra/infrastructure.md
git commit -m "infra: sync service verified live - clone, push, and core read-only"
```

**Phase 1 is complete when:** `https://<host>/healthz` answers over TLS, a `team-*` push succeeds from a laptop, and a `core` push is rejected.

---

## What Phase 1 deliberately does not do

- No client changes. `apps/client` still never attaches a remote; every workspace still reports `local`. That is Phase 2.
- No sign-in. Setup tokens are minted by the founder tool only. That is Phase 3.
- No automations tick loop (spec decision 7).
- No repo backup transport. `/srv/buildex/repos` relies on Fly volume snapshots until a snapshot job lands; called out in the ledger rather than assumed.
