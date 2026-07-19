import { describe, it, expect } from "vitest";
import { SyncScheduler } from "./scheduler.js";
import type { SyncResult } from "./engine.js";

/** Let the microtask/macrotask queue drain so an async flush settles before we assert. The scheduler's
 *  own timers run on the FakeClock (advanced explicitly); this only flushes the awaited git work. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A controllable clock: timers fire in due order as time is advanced. No real time passes. */
class FakeClock {
  t = 0;
  private id = 0;
  private timers = new Map<number, { due: number; fn: () => void }>();
  now() {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): number {
    const id = ++this.id;
    this.timers.set(id, { due: this.t + ms, fn });
    return id;
  }
  clearTimer(id: number) {
    this.timers.delete(id);
  }
  /** Advance time by ms, firing every timer whose due time is reached, earliest first. */
  advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].due <= target && (!next || entry[1].due < next[1].due)) next = entry;
      }
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].due;
      next[1].fn();
    }
    this.t = target;
  }
}

/** A fake SyncEngine: records the dirs it was asked to sync, returns a scripted result queue. Async
 *  (like the real engine now), but resolves immediately - `await tick()` in the test settles it. */
class FakeEngine {
  calls: string[] = [];
  results: SyncResult[] = [];
  async syncWritable(dir: string): Promise<SyncResult> {
    this.calls.push(dir);
    return this.results.shift() ?? "ok";
  }
}

function make(opts: { roots?: string[]; engine?: FakeEngine } = {}) {
  const clock = new FakeClock();
  const engine = opts.engine ?? new FakeEngine();
  const statuses: string[] = [];
  const scheduler = new SyncScheduler({
    engine,
    writableRoots: () => opts.roots ?? ["/team", "/private"],
    clock,
    onStatus: (s) => statuses.push(s),
  });
  return { clock, engine, statuses, scheduler };
}

describe("SyncScheduler - debounce", () => {
  it("coalesces a burst of touches into a single sync per root", async () => {
    const { clock, engine, scheduler } = make();
    for (let i = 0; i < 5; i++) scheduler.touch("/team");
    expect(engine.calls).toEqual([]); // nothing yet - still inside the quiet window
    clock.advance(2000);
    await tick();
    expect(engine.calls).toEqual(["/team"]); // exactly one sync, not five
  });

  it("forces a flush after maxWait when a continuous stream keeps resetting the debounce", async () => {
    const { clock, engine, scheduler } = make();
    // touch every 1500ms (< the 2000ms quiet window) so the debounce never fires on its own
    for (let i = 0; i < 7; i++) {
      scheduler.touch("/team");
      clock.advance(1500);
      await tick();
    }
    // by ~10s the maxWait cap must have forced exactly one flush
    expect(engine.calls).toEqual(["/team"]);
  });
});

describe("SyncScheduler - status", () => {
  it("emits busy then ok around a successful flush", async () => {
    const { clock, statuses, scheduler } = make();
    scheduler.touch("/team");
    clock.advance(2000);
    await tick();
    expect(statuses).toEqual(["busy", "ok"]);
  });

  it("reports needs-help when a root's sync needs attention", async () => {
    const engine = new FakeEngine();
    engine.results = ["needs-help"];
    const { clock, statuses, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    clock.advance(2000);
    await tick();
    expect(statuses).toEqual(["busy", "needs-help"]);
  });

  it("takes the worst status across multiple roots", async () => {
    const engine = new FakeEngine();
    engine.results = ["ok", "queued"]; // /team ok, /private offline
    const { clock, statuses, scheduler } = make({ engine, roots: ["/team", "/private"] });
    scheduler.touch("/team");
    scheduler.touch("/private");
    clock.advance(2000);
    await tick();
    expect(statuses).toEqual(["busy", "queued"]);
  });

  it("regenerates the agent config before syncing", async () => {
    const clock = new FakeClock();
    const order: string[] = [];
    const scheduler = new SyncScheduler({
      engine: {
        async syncWritable(dir) {
          order.push("sync:" + dir);
          return "ok";
        },
      },
      writableRoots: () => ["/team"],
      clock,
      regenConfig: () => order.push("regen"),
    });
    scheduler.touch("/team");
    clock.advance(2000);
    await tick();
    expect(order).toEqual(["regen", "sync:/team"]);
  });
});

describe("SyncScheduler - local (unsynced) state", () => {
  it("reports 'local' when every root is local-only (no account/remote yet)", async () => {
    const engine = new FakeEngine();
    engine.results = ["local", "local"];
    const { clock, statuses, scheduler } = make({ engine, roots: ["/team", "/private"] });
    scheduler.touch("/team");
    scheduler.touch("/private");
    clock.advance(2000);
    await tick();
    expect(statuses).toEqual(["busy", "local"]);
  });

  it("does not schedule a backoff retry for a local root (nothing to retry - it's local by design)", async () => {
    const engine = new FakeEngine();
    engine.results = ["local"];
    const { clock, engine: _e, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    clock.advance(2000);
    await tick();
    clock.advance(60000); // long idle - a local root must not trigger the offline backoff loop
    await tick();
    expect(engine.calls).toEqual(["/team"]);
  });

  it("ranks a real problem above local: needs-help/queued win over a local root", async () => {
    const engine = new FakeEngine();
    engine.results = ["local", "queued"]; // one repo local, one has a remote but is offline
    const { clock, statuses, scheduler } = make({ engine, roots: ["/team", "/private"] });
    scheduler.touch("/team");
    scheduler.touch("/private");
    clock.advance(2000);
    await tick();
    expect(statuses).toEqual(["busy", "queued"]);
  });
});

describe("SyncScheduler - offline backoff", () => {
  it("retries a queued (offline) root after the backoff delay, then settles", async () => {
    const engine = new FakeEngine();
    engine.results = ["queued", "ok"]; // offline once, then reconnects
    const { clock, statuses, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    clock.advance(2000); // first flush → queued
    await tick();
    expect(engine.calls).toEqual(["/team"]);
    expect(statuses).toEqual(["busy", "queued"]);

    clock.advance(5000); // backoff elapses → retry, now succeeds
    await tick();
    expect(engine.calls).toEqual(["/team", "/team"]);
    expect(statuses).toEqual(["busy", "queued", "busy", "ok"]);
  });

  it("does not keep retrying once a flush succeeds", async () => {
    const engine = new FakeEngine();
    engine.results = ["ok"];
    const { clock, engine: _e, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    clock.advance(2000);
    await tick();
    clock.advance(60000); // long idle - no backoff retries should fire
    await tick();
    expect(engine.calls).toEqual(["/team"]);
  });
});

describe("SyncScheduler - pull tick", () => {
  it("fetches every writable root on the idle pull tick, with no local changes", async () => {
    const { clock, engine, scheduler } = make({ roots: ["/team", "/private"] });
    scheduler.start();
    clock.advance(45000);
    await tick();
    expect([...engine.calls].sort()).toEqual(["/private", "/team"]);
  });

  it("keeps ticking on the pull interval", async () => {
    const { clock, engine, scheduler } = make({ roots: ["/team"] });
    scheduler.start();
    clock.advance(45000);
    await tick();
    clock.advance(45000);
    await tick();
    expect(engine.calls).toEqual(["/team", "/team"]);
  });
});

describe("SyncScheduler - stop", () => {
  it("flushes pending work and halts all timers on stop()", async () => {
    const { clock, engine, scheduler } = make({ roots: ["/team"] });
    scheduler.start();
    scheduler.touch("/team"); // pending - debounce has not fired yet
    scheduler.stop();
    await tick(); // the final flush is fire-and-forget (async sync); let it settle
    expect(engine.calls).toEqual(["/team"]);
    clock.advance(100000); // nothing should fire after stop
    await tick();
    expect(engine.calls).toEqual(["/team"]);
  });
});

describe("SyncScheduler - writable guard", () => {
  it("ignores a touch for a non-writable (core) root", async () => {
    const { clock, engine, scheduler } = make({ roots: ["/team"] });
    scheduler.touch("/core"); // core is read-only (invariant 6) - must never be committed
    clock.advance(10000);
    await tick();
    expect(engine.calls).toEqual([]);
  });
});

describe("SyncScheduler - flushNow", () => {
  it("syncs every writable root immediately and returns the worst status", async () => {
    const engine = new FakeEngine();
    engine.results = ["ok", "queued"];
    const { scheduler } = make({ engine, roots: ["/team", "/private"] });
    const status = await scheduler.flushNow();
    expect([...engine.calls].sort()).toEqual(["/private", "/team"]);
    expect(status).toBe("queued");
  });
});

describe("SyncScheduler - resilience", () => {
  it("does not crash when one root's sync throws; other roots still sync", async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    const engine = {
      async syncWritable(dir: string): Promise<SyncResult> {
        calls.push(dir);
        if (dir === "/bad") throw new Error("not a git repo");
        return "ok";
      },
    };
    const statuses: string[] = [];
    const scheduler = new SyncScheduler({
      engine,
      writableRoots: () => ["/bad", "/team"],
      clock,
      onStatus: (s) => statuses.push(s),
    });
    scheduler.touch("/bad");
    scheduler.touch("/team");
    clock.advance(2000);
    await tick();
    expect([...calls].sort()).toEqual(["/bad", "/team"]);
    expect(statuses).toEqual(["busy", "ok"]); // the throw is swallowed; the good root still reports
  });
});
