import { describe, it, expect } from "vitest";
import { SyncScheduler } from "./scheduler.js";
import type { SyncResult, CheckpointResult, ReceiveResult } from "./engine.js";

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

/** A fake SyncEngine: records the dirs asked of each operation separately (checkpoint/receive/publish
 *  never fold into one bucket now - the whole point of this task is that they have different callers).
 *  Each operation's result can be pre-loaded as a queue (shifted per call, for per-root scripting), and
 *  `publishResult` is a simpler steerable default for tests that just need to flip one behavior. */
class FakeEngine {
  calls: { checkpoint: string[]; receive: string[]; publish: string[]; syncReadonly: string[] } = {
    checkpoint: [],
    receive: [],
    publish: [],
    syncReadonly: [],
  };
  checkpointResults: CheckpointResult[] = [];
  receiveResults: ReceiveResult[] = [];
  publishResults: SyncResult[] = [];
  publishResult: SyncResult = "ok";

  async checkpoint(dir: string): Promise<CheckpointResult> {
    this.calls.checkpoint.push(dir);
    return this.checkpointResults.shift() ?? "committed";
  }
  async receive(dir: string): Promise<ReceiveResult> {
    this.calls.receive.push(dir);
    return this.receiveResults.shift() ?? "ok";
  }
  async publish(dir: string): Promise<SyncResult> {
    this.calls.publish.push(dir);
    return this.publishResults.shift() ?? this.publishResult;
  }
  async syncReadonly(dir: string): Promise<void> {
    this.calls.syncReadonly.push(dir);
  }
}

function make(opts: { roots?: string[]; readonlyRoots?: string[]; engine?: FakeEngine } = {}) {
  const clock = new FakeClock();
  const engine = opts.engine ?? new FakeEngine();
  const statuses: string[] = [];
  const scheduler = new SyncScheduler({
    engine,
    writableRoots: () => opts.roots ?? ["/team", "/private"],
    readonlyRoots: () => opts.readonlyRoots ?? [],
    clock,
    onStatus: (s) => statuses.push(s),
  });
  return { clock, engine, statuses, scheduler };
}

describe("SyncScheduler - debounce", () => {
  it("coalesces a burst of touches into a single checkpoint per root", async () => {
    const { clock, engine, scheduler } = make();
    for (let i = 0; i < 5; i++) scheduler.touch("/team");
    expect(engine.calls.checkpoint).toEqual([]); // nothing yet - still inside the quiet window
    clock.advance(2000);
    await tick();
    expect(engine.calls.checkpoint).toEqual(["/team"]); // exactly one checkpoint, not five
  });

  it("forces a flush after maxWait when a continuous stream keeps resetting the debounce", async () => {
    const { clock, engine, scheduler } = make();
    // touch every 1500ms (< the 2000ms quiet window) so the debounce never fires on its own
    for (let i = 0; i < 7; i++) {
      scheduler.touch("/team");
      clock.advance(1500);
      await tick();
    }
    // by ~10s the maxWait cap must have forced exactly one checkpoint
    expect(engine.calls.checkpoint).toEqual(["/team"]);
  });
});

describe("SyncScheduler - status", () => {
  it("emits busy then the worst status when the operator publishes", async () => {
    const { statuses, scheduler } = make({ roots: ["/team"] });
    scheduler.touch("/team");
    await scheduler.publishAll();
    expect(statuses).toEqual(["busy", "ok"]);
  });

  it("reports needs-help when a root's publish needs attention", async () => {
    const engine = new FakeEngine();
    engine.publishResults = ["needs-help"];
    const { statuses, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    await scheduler.publishAll();
    expect(statuses).toEqual(["busy", "needs-help"]);
  });

  it("takes the worst status across multiple roots", async () => {
    const engine = new FakeEngine();
    engine.publishResults = ["ok", "queued"]; // /team ok, /private offline
    const { statuses, scheduler } = make({ engine, roots: ["/team", "/private"] });
    scheduler.touch("/team");
    scheduler.touch("/private");
    await scheduler.publishAll();
    expect(statuses).toEqual(["busy", "queued"]);
  });

  it("regenerates the agent config before checkpointing", async () => {
    const clock = new FakeClock();
    const order: string[] = [];
    const scheduler = new SyncScheduler({
      engine: {
        async checkpoint(dir: string): Promise<CheckpointResult> {
          order.push("checkpoint:" + dir);
          return "committed";
        },
        async receive(): Promise<ReceiveResult> {
          return "ok";
        },
        async publish(): Promise<SyncResult> {
          return "ok";
        },
        async syncReadonly(): Promise<void> {},
      },
      writableRoots: () => ["/team"],
      readonlyRoots: () => [],
      clock,
      regenConfig: () => order.push("regen"),
    });
    scheduler.touch("/team");
    clock.advance(2000);
    await tick();
    expect(order).toEqual(["regen", "checkpoint:/team"]);
  });
});

describe("SyncScheduler - local (unsynced) state", () => {
  it("reports 'local' when every root is local-only (no account/remote yet)", async () => {
    const engine = new FakeEngine();
    engine.publishResults = ["local", "local"];
    const { statuses, scheduler } = make({ engine, roots: ["/team", "/private"] });
    scheduler.touch("/team");
    scheduler.touch("/private");
    await scheduler.publishAll();
    expect(statuses).toEqual(["busy", "local"]);
  });

  it("does not schedule a backoff retry for a local root (nothing to retry - it's local by design)", async () => {
    const engine = new FakeEngine();
    engine.publishResults = ["local"];
    const { clock, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    await scheduler.publishAll();
    clock.advance(60000); // long idle - a local root must not trigger the offline backoff loop
    await tick();
    expect(engine.calls.publish).toEqual(["/team"]);
  });

  it("ranks a real problem above local: needs-help/queued win over a local root", async () => {
    const engine = new FakeEngine();
    engine.publishResults = ["local", "queued"]; // one repo local, one has a remote but is offline
    const { statuses, scheduler } = make({ engine, roots: ["/team", "/private"] });
    scheduler.touch("/team");
    scheduler.touch("/private");
    await scheduler.publishAll();
    expect(statuses).toEqual(["busy", "queued"]);
  });
});

describe("SyncScheduler - offline backoff", () => {
  it("retries a queued (offline) root after the backoff delay, then settles", async () => {
    const engine = new FakeEngine();
    engine.publishResults = ["queued", "ok"]; // offline once, then reconnects
    const { clock, statuses, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    await scheduler.publishAll(); // first publish → queued
    expect(engine.calls.publish).toEqual(["/team"]);
    expect(statuses).toEqual(["busy", "queued"]);

    clock.advance(5000); // backoff elapses → retry, now succeeds
    await tick();
    expect(engine.calls.publish).toEqual(["/team", "/team"]);
    expect(statuses).toEqual(["busy", "queued", "busy", "ok"]);
  });

  it("does not keep retrying once a publish succeeds", async () => {
    const engine = new FakeEngine();
    engine.publishResults = ["ok"];
    const { clock, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    await scheduler.publishAll();
    clock.advance(60000); // long idle - no backoff retries should fire
    await tick();
    expect(engine.calls.publish).toEqual(["/team"]);
  });
});

describe("SyncScheduler - pull tick", () => {
  it("receives every writable root and syncs every readonly root on the idle pull tick", async () => {
    const { clock, engine, scheduler } = make({ roots: ["/team", "/private"], readonlyRoots: ["/core"] });
    scheduler.start();
    clock.advance(45000);
    await tick();
    expect([...engine.calls.receive].sort()).toEqual(["/private", "/team"]);
    expect(engine.calls.syncReadonly).toEqual(["/core"]);
    expect(engine.calls.publish).toEqual([]); // the tick never sends
  });

  it("keeps ticking on the pull interval", async () => {
    const { clock, engine, scheduler } = make({ roots: ["/team"] });
    scheduler.start();
    clock.advance(45000);
    await tick();
    clock.advance(45000);
    await tick();
    expect(engine.calls.receive).toEqual(["/team", "/team"]);
  });
});

describe("SyncScheduler - stop", () => {
  it("checkpoints pending work and halts all timers on stop() - it records, it never sends", async () => {
    const { clock, engine, scheduler } = make({ roots: ["/team"] });
    scheduler.start();
    scheduler.touch("/team"); // pending - debounce has not fired yet
    scheduler.stop();
    await tick(); // the final flush is fire-and-forget (async checkpoint); let it settle
    expect(engine.calls.checkpoint).toEqual(["/team"]);
    expect(engine.calls.publish).toEqual([]);
    clock.advance(100000); // nothing should fire after stop
    await tick();
    expect(engine.calls.checkpoint).toEqual(["/team"]);
  });
});

describe("SyncScheduler - writable guard", () => {
  it("ignores a touch for a non-writable (core) root", async () => {
    const { clock, engine, scheduler } = make({ roots: ["/team"] });
    scheduler.touch("/core"); // core is read-only (invariant 6) - must never be committed
    clock.advance(10000);
    await tick();
    expect(engine.calls.checkpoint).toEqual([]);
  });
});

describe("SyncScheduler - publishAll", () => {
  it("publishes every writable root immediately and returns the worst status", async () => {
    const engine = new FakeEngine();
    engine.publishResults = ["ok", "queued"];
    const { scheduler } = make({ engine, roots: ["/team", "/private"] });
    const status = await scheduler.publishAll();
    expect([...engine.calls.publish].sort()).toEqual(["/private", "/team"]);
    expect(status).toBe("queued");
  });

  it("records the per-root status of the last publish", async () => {
    const engine = new FakeEngine();
    engine.publishResults = ["ok", "queued"];
    const { scheduler } = make({ engine, roots: ["/team", "/private"] });
    await scheduler.publishAll();
    expect(scheduler.perRoot()).toEqual({ "/team": "ok", "/private": "queued" });
  });
});

describe("SyncScheduler - resilience", () => {
  it("does not crash when one root's checkpoint throws; other roots still checkpoint", async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    const engine = {
      async checkpoint(dir: string): Promise<CheckpointResult> {
        calls.push(dir);
        if (dir === "/bad") throw new Error("not a git repo");
        return "committed";
      },
      async receive(): Promise<ReceiveResult> {
        return "ok";
      },
      async publish(): Promise<SyncResult> {
        return "ok";
      },
      async syncReadonly(): Promise<void> {},
    };
    const scheduler = new SyncScheduler({
      engine,
      writableRoots: () => ["/bad", "/team"],
      readonlyRoots: () => [],
      clock,
    });
    scheduler.touch("/bad");
    scheduler.touch("/team");
    clock.advance(2000);
    await tick();
    expect([...calls].sort()).toEqual(["/bad", "/team"]);
  });

  it("does not crash when one root's publish throws, and surfaces it as needing attention", async () => {
    const calls: string[] = [];
    const engine = {
      async checkpoint(): Promise<CheckpointResult> {
        return "committed";
      },
      async receive(): Promise<ReceiveResult> {
        return "ok";
      },
      async publish(dir: string): Promise<SyncResult> {
        calls.push(dir);
        if (dir === "/bad") throw new Error("network error");
        return "ok";
      },
      async syncReadonly(): Promise<void> {},
    };
    const statuses: string[] = [];
    const scheduler = new SyncScheduler({
      engine,
      writableRoots: () => ["/bad", "/team"],
      readonlyRoots: () => [],
      clock: new FakeClock(),
      onStatus: (s) => statuses.push(s),
    });
    const status = await scheduler.publishAll();
    expect([...calls].sort()).toEqual(["/bad", "/team"]);
    // A throw is a failure to send. Ranking it with "ok" would paint the dot green and tell the
    // operator their work reached the company when it never left the machine.
    expect(status).toBe("needs-help");
    expect(statuses).toEqual(["busy", "needs-help"]);
  });
});

describe("manual save", () => {
  // The scheduler's own default roots (/team, /private) are also used by other describes in this
  // file; these use distinct /w/-prefixed names purely so this block's expectations read standalone.
  function makeScheduler() {
    return make({ roots: ["/w/team", "/w/private"], readonlyRoots: ["/w/core"] });
  }

  it("records work on the debounce but never sends it", async () => {
    const { scheduler, engine, clock } = makeScheduler();
    scheduler.touch("/w/team");
    await clock.advance(10_000);
    expect(engine.calls.checkpoint).toEqual(["/w/team"]);
    expect(engine.calls.publish).toEqual([]);
  });

  it("takes teammates' work in on the background tick, and still sends nothing", async () => {
    const { scheduler, engine, clock } = makeScheduler();
    scheduler.start();
    clock.advance(45_000);
    // receiveAll awaits its two writable roots sequentially (not Promise.all - see scheduler.ts), so
    // a bare `await advance()` isn't enough microtask draining for the second root; tick() flushes it.
    await tick();
    expect(engine.calls.receive).toEqual(["/w/team", "/w/private"]);
    expect(engine.calls.syncReadonly).toEqual(["/w/core"]);
    expect(engine.calls.publish).toEqual([]);
  });

  it("sends everything only when the operator asks", async () => {
    const { scheduler, engine } = makeScheduler();
    expect(await scheduler.publishAll()).toBe("ok");
    expect(engine.calls.publish).toEqual(["/w/team", "/w/private"]);
  });

  it("never sends core, which is read-only", async () => {
    const { scheduler, engine } = makeScheduler();
    scheduler.touch("/w/core");
    await scheduler.publishAll();
    expect(engine.calls.checkpoint).not.toContain("/w/core");
    expect(engine.calls.publish).not.toContain("/w/core");
  });

  it("records but does not send on shutdown - quitting must not publish", async () => {
    const { scheduler, engine } = makeScheduler();
    scheduler.touch("/w/team");
    scheduler.stop();
    await Promise.resolve();
    expect(engine.calls.publish).toEqual([]);
  });

  it("retries a save that failed while offline", async () => {
    const { scheduler, engine, clock } = makeScheduler();
    engine.publishResult = "queued";
    expect(await scheduler.publishAll()).toBe("queued");
    engine.publishResult = "ok";
    await clock.advance(5_000);
    expect(engine.calls.publish.length).toBeGreaterThan(2);
  });

  it("checkpoints each writable root BEFORE receiving it on the tick", async () => {
    // Receiving rebases, and a rebase refuses to start on a dirty tree - the engine then treats
    // that as a conflict and hard-resets to the remote. Work the operator never checkpointed is
    // not in the conflict backup set, so it would be destroyed (invariant 8). Checkpointing first
    // makes the tree clean; checkpointing is network-free, so the tick still sends nothing.
    const order: string[] = [];
    const clock = new FakeClock();
    const scheduler = new SyncScheduler({
      engine: {
        async checkpoint(dir: string): Promise<CheckpointResult> {
          order.push("checkpoint:" + dir);
          return "committed";
        },
        async receive(dir: string): Promise<ReceiveResult> {
          order.push("receive:" + dir);
          return "ok";
        },
        async publish(): Promise<SyncResult> {
          order.push("publish");
          return "ok";
        },
        async syncReadonly(): Promise<void> {},
      },
      writableRoots: () => ["/w/team", "/w/private"],
      readonlyRoots: () => [],
      clock,
    });
    scheduler.start();
    clock.advance(45_000);
    await tick();
    expect(order).toEqual([
      "checkpoint:/w/team",
      "receive:/w/team",
      "checkpoint:/w/private",
      "receive:/w/private",
    ]);
    expect(order).not.toContain("publish");
  });

  it("never runs a tick and a save against the same root at the same time", async () => {
    // Two git operations in one worktree race on the index lock; worse, a rebase that fails for
    // that reason trips the engine's conflict path - a spurious "needs help" and a hard reset.
    let inFlight = 0;
    let overlapped = false;
    const clock = new FakeClock();
    const gate: (() => void)[] = [];
    const slow = async <T,>(v: T): Promise<T> => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise<void>((r) => gate.push(r));
      inFlight--;
      return v;
    };
    const scheduler = new SyncScheduler({
      engine: {
        checkpoint: () => slow<CheckpointResult>("committed"),
        receive: () => slow<ReceiveResult>("ok"),
        publish: () => slow<SyncResult>("ok"),
        async syncReadonly(): Promise<void> {},
      },
      writableRoots: () => ["/w/team"],
      readonlyRoots: () => [],
      clock,
    });
    scheduler.start();
    const publishP = scheduler.publishAll(); // operator saves...
    clock.advance(45_000); // ...and the tick fires while it is still in flight
    // Release every operation as it queues; nothing may ever be in flight two at a time.
    for (let i = 0; i < 20; i++) {
      gate.shift()?.();
      await tick();
    }
    await publishP;
    expect(overlapped).toBe(false);
  });

  it("retries only the roots pending at click time, and never re-records newer work", async () => {
    // The operator saved, then kept working for an hour. When connectivity returns, the retry must
    // send what they asked to send - not everything they have done since.
    const { scheduler, engine, clock } = makeScheduler();
    engine.publishResults = ["ok", "queued"]; // /w/team went out; /w/private was offline
    await scheduler.publishAll();
    expect(engine.calls.checkpoint).toEqual([]); // nothing was dirty at click time

    // The operator keeps working. This touch is still inside its 2s quiet window when the 5s
    // backoff fires, so a retry that flushed would checkpoint it and then send it.
    clock.advance(4_000);
    scheduler.touch("/w/team");

    engine.calls.publish.length = 0;
    clock.advance(1_000); // connectivity returns; the retry fires at t=5s
    await tick();
    expect(engine.calls.publish).toEqual(["/w/private"]); // only the root that was still pending
    expect(engine.calls.checkpoint).toEqual([]); // and nothing newer was recorded to be sent
  });

  it("gives up retrying while offline instead of re-running forever, leaving the state queued", async () => {
    const { scheduler, engine, clock, statuses } = makeScheduler();
    engine.publishResult = "queued";
    await scheduler.publishAll();
    for (let i = 0; i < 12; i++) {
      clock.advance(200_000); // well past every doubling delay
      await tick();
    }
    // 1 initial attempt + at most MAX_RETRIES (5) retries, over 2 roots.
    expect(engine.calls.publish.length).toBeLessThanOrEqual(12);
    expect(statuses[statuses.length - 1]).toBe("queued"); // the operator can save again by hand
  });

  it("signals busy the instant the operator saves, even while a background tick holds the lease", async () => {
    // A save shares the per-root lease with the background receive tick. If the tick is mid network
    // op, publishAll's flush queues behind it and can stall for seconds. The operator must see their
    // click register immediately - the dot must go busy now, not only once the tick's receive returns.
    const clock = new FakeClock();
    const releaseReceive: (() => void)[] = [];
    const engine = {
      async checkpoint(): Promise<CheckpointResult> {
        return "committed";
      },
      receive: (): Promise<ReceiveResult> =>
        new Promise<ReceiveResult>((r) => releaseReceive.push(() => r("ok"))), // holds the lease open
      async publish(): Promise<SyncResult> {
        return "ok";
      },
      async syncReadonly(): Promise<void> {},
    };
    const statuses: string[] = [];
    const scheduler = new SyncScheduler({
      engine,
      writableRoots: () => ["/team"],
      readonlyRoots: () => [],
      clock,
      onStatus: (s) => statuses.push(s),
    });
    scheduler.start();
    clock.advance(45_000); // the tick fires and receive is now holding /team's lease, unresolved
    await tick();
    // Dirty work created AFTER the tick took the lease - so the save's flush must queue for that lease
    // (touching earlier would let the 2s debounce checkpoint and clear it before the tick, and flush
    // would then early-return without ever taking the lease, hiding the very stall this guards).
    scheduler.touch("/team");
    expect(statuses).toEqual([]); // the tick emitted nothing; the dot is idle

    const publishP = scheduler.publishAll(); // operator clicks Save while the tick is mid-flight
    await tick();
    expect(statuses).toContain("busy"); // busy NOW - not blocked behind the receive still in flight

    for (let i = 0; i < 20 && releaseReceive.length; i++) {
      releaseReceive.shift()!();
      await tick();
    }
    await publishP;
  });

  it("cancels a pending offline backoff retry on shutdown - quitting must never publish", async () => {
    const { scheduler, engine, clock } = makeScheduler();
    engine.publishResult = "queued";
    expect(await scheduler.publishAll()).toBe("queued"); // arms the 5s backoff retry
    const publishCallsBeforeStop = engine.calls.publish.length;
    scheduler.stop();
    clock.advance(30_000); // well past the 5s backoff - if the retry survived, it would fire in here
    await tick();
    expect(engine.calls.publish.length).toBe(publishCallsBeforeStop); // no further publish after stop
  });
});
