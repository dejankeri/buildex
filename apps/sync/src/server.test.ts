import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, chmodSync } from "node:fs";
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

  it("rejects when the git service cannot create the core repo", async () => {
    // Root bypasses permission bits, and Windows ignores them - apps/sync is Linux-only anyway.
    if (process.platform === "win32" || process.getuid?.() === 0) return;

    // This only verifies the rejection path itself. The handle cleanup it is meant to guard
    // (both stores getting closed before the throw propagates) is enforced by createServices'
    // structure, not directly observable from here - node:sqlite does not expose open-handle
    // counts to assert against.
    const locked = join(dir, "locked");
    mkdirSync(join(locked, "repos"), { recursive: true });
    chmodSync(join(locked, "repos"), 0o500); // readable + traversable, not writable
    try {
      await expect(createServices(config({ dataDir: locked }))).rejects.toThrow();
    } finally {
      chmodSync(join(locked, "repos"), 0o700); // let afterEach clean up
    }
  });
});
