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
    const exit = vi.fn<(code: number) => void>();

    installShutdown(stopFn, on, exit);

    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);

    handlers.get("SIGTERM")!();
    handlers.get("SIGINT")!();
    await vi.waitFor(() => expect(stopFn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("exits non-zero when the graceful stop fails", async () => {
    const handlers = new Map<string, () => void>();
    const on = (signal: string, handler: () => void) => {
      handlers.set(signal, handler);
    };
    const stopFn = vi.fn(async () => {
      throw new Error("close failed");
    });
    const exit = vi.fn<(code: number) => void>();

    installShutdown(stopFn, on, exit);
    handlers.get("SIGTERM")!();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
