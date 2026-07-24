import { describe, it, expect } from "vitest";
import { SyncScheduler, saveResultStatus, type SyncStatus } from "./scheduler.js";
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

/** A fake SyncEngine: records the dirs asked of each operation separately (checkpoint/receive/save
 *  never fold into one bucket - they have different callers). `messages` records what each save was
 *  named. Each operation's result can be pre-loaded as a queue (shifted per call, for per-root
 *  scripting), and `saveResult` is a simpler steerable default for tests that flip one behavior. */
class FakeEngine {
  calls: { checkpoint: string[]; receive: string[]; save: string[]; pushSave: string[]; saveScoped: string[]; syncReadonly: string[] } = {
    checkpoint: [],
    receive: [],
    save: [],
    pushSave: [],
    saveScoped: [],
    syncReadonly: [],
  };
  messages: (string | undefined)[] = [];
  checkpointResults: CheckpointResult[] = [];
  receiveResults: ReceiveResult[] = [];
  saveResults: SyncResult[] = [];
  saveResult: SyncResult = "ok";
  pushSaveResults: SyncResult[] = [];
  pushSaveResult: SyncResult = "ok";
  saveScopedResult: SyncResult = "ok";

  async checkpoint(dir: string): Promise<CheckpointResult> {
    this.calls.checkpoint.push(dir);
    return this.checkpointResults.shift() ?? "committed";
  }
  async receive(dir: string): Promise<ReceiveResult> {
    this.calls.receive.push(dir);
    return this.receiveResults.shift() ?? "ok";
  }
  async save(dir: string, message?: string): Promise<SyncResult> {
    this.calls.save.push(dir);
    this.messages.push(message);
    return this.saveResults.shift() ?? this.saveResult;
  }
  async pushSave(dir: string): Promise<SyncResult> {
    this.calls.pushSave.push(dir);
    return this.pushSaveResults.shift() ?? this.pushSaveResult;
  }
  async saveScoped(dir: string): Promise<SyncResult> {
    this.calls.saveScoped.push(dir);
    return this.saveScopedResult;
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
  it("emits busy then the worst status when the operator saves", async () => {
    const { statuses, scheduler } = make({ roots: ["/team"] });
    scheduler.touch("/team");
    await scheduler.saveAll();
    expect(statuses).toEqual(["busy", "ok"]);
  });

  it("reports needs-help when a root's save needs attention", async () => {
    const engine = new FakeEngine();
    engine.saveResults = ["needs-help"];
    const { statuses, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    await scheduler.saveAll();
    expect(statuses).toEqual(["busy", "needs-help"]);
  });

  it("takes the worst status across multiple roots", async () => {
    const engine = new FakeEngine();
    engine.saveResults = ["ok", "queued"]; // /team ok, /private offline
    const { statuses, scheduler } = make({ engine, roots: ["/team", "/private"] });
    scheduler.touch("/team");
    scheduler.touch("/private");
    await scheduler.saveAll();
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
        async save(): Promise<SyncResult> {
          return "ok";
        },
        async pushSave(): Promise<SyncResult> {
          return "ok";
        },
        async saveScoped(): Promise<SyncResult> {
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
    engine.saveResults = ["local", "local"];
    const { statuses, scheduler } = make({ engine, roots: ["/team", "/private"] });
    scheduler.touch("/team");
    scheduler.touch("/private");
    await scheduler.saveAll();
    expect(statuses).toEqual(["busy", "local"]);
  });

  it("does not schedule a backoff retry for a local root (nothing to retry - it's local by design)", async () => {
    const engine = new FakeEngine();
    engine.saveResults = ["local"];
    const { clock, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    await scheduler.saveAll();
    clock.advance(60000); // long idle - a local root must not trigger the offline backoff loop
    await tick();
    expect(engine.calls.save).toEqual(["/team"]);
    expect(engine.calls.pushSave).toEqual([]);
  });

  it("ranks a real problem above local: needs-help/queued win over a local root", async () => {
    const engine = new FakeEngine();
    engine.saveResults = ["local", "queued"]; // one repo local, one has a remote but is offline
    const { statuses, scheduler } = make({ engine, roots: ["/team", "/private"] });
    scheduler.touch("/team");
    scheduler.touch("/private");
    await scheduler.saveAll();
    expect(statuses).toEqual(["busy", "queued"]);
  });
});

describe("SyncScheduler - offline backoff", () => {
  it("retries a queued (offline) root after the backoff delay - pushing the NAMED save, never re-squashing", async () => {
    const engine = new FakeEngine();
    engine.saveResults = ["queued"]; // offline at click time
    engine.pushSaveResults = ["ok"]; // reconnects by the retry
    const { clock, statuses, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    await scheduler.saveAll(); // first save → queued
    expect(engine.calls.save).toEqual(["/team"]);
    expect(statuses).toEqual(["busy", "queued"]);

    clock.advance(5000); // backoff elapses → retry, now succeeds
    await tick();
    expect(engine.calls.pushSave).toEqual(["/team"]); // the retry is a push of the named save
    expect(engine.calls.save).toEqual(["/team"]); // never a second squash
    expect(statuses).toEqual(["busy", "queued", "busy", "ok"]);
  });

  it("does not keep retrying once a save succeeds", async () => {
    const engine = new FakeEngine();
    engine.saveResults = ["ok"];
    const { clock, scheduler } = make({ engine, roots: ["/team"] });
    scheduler.touch("/team");
    await scheduler.saveAll();
    clock.advance(60000); // long idle - no backoff retries should fire
    await tick();
    expect(engine.calls.save).toEqual(["/team"]);
    expect(engine.calls.pushSave).toEqual([]);
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
    expect(engine.calls.save).toEqual([]); // the tick never sends
    expect(engine.calls.pushSave).toEqual([]);
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
    expect(engine.calls.save).toEqual([]);
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

describe("SyncScheduler - saveAll", () => {
  it("saves every writable root immediately and returns the worst status", async () => {
    const engine = new FakeEngine();
    engine.saveResults = ["ok", "queued"];
    const { scheduler } = make({ engine, roots: ["/team", "/private"] });
    const status = await scheduler.saveAll();
    expect([...engine.calls.save].sort()).toEqual(["/private", "/team"]);
    expect(status).toBe("queued");
  });

  it("hands the operator's message through to every root's save", async () => {
    const engine = new FakeEngine();
    const { scheduler } = make({ engine, roots: ["/team", "/private"] });
    await scheduler.saveAll("Repriced the Pro tier");
    expect(engine.messages).toEqual(["Repriced the Pro tier", "Repriced the Pro tier"]);
  });

  it("records the per-root status of the last save", async () => {
    const engine = new FakeEngine();
    engine.saveResults = ["ok", "queued"];
    const { scheduler } = make({ engine, roots: ["/team", "/private"] });
    await scheduler.saveAll();
    expect(scheduler.perRoot()).toEqual({ "/team": "ok", "/private": "queued" });
  });
});

describe("SyncScheduler - saveScoped (the ledger's auto-save)", () => {
  it("runs the engine's scoped save for the root", async () => {
    const engine = new FakeEngine();
    const { scheduler } = make({ engine, roots: ["/team"] });
    await scheduler.saveScoped("/team", "activity/", "Activity ledger update");
    expect(engine.calls.saveScoped).toEqual(["/team"]);
  });

  it("surfaces only the states the operator must act on", async () => {
    const engine = new FakeEngine();
    engine.saveScopedResult = "needs-help";
    const { scheduler, statuses } = make({ engine, roots: ["/team"] });
    await scheduler.saveScoped("/team", "activity/", "Activity ledger update");
    expect(statuses).toEqual(["needs-help"]);
  });

  it("stays quiet on a skipped or offline auto-save - the entry rides the next manual save", async () => {
    const engine = new FakeEngine();
    engine.saveScopedResult = "queued";
    const { scheduler, statuses } = make({ engine, roots: ["/team"] });
    await scheduler.saveScoped("/team", "activity/", "Activity ledger update");
    expect(statuses).toEqual([]);
  });

  it("never throws - a failed auto-save leaves the checkpointed entry for the next save", async () => {
    const engine = {
      async checkpoint(): Promise<CheckpointResult> { return "committed"; },
      async receive(): Promise<ReceiveResult> { return "ok"; },
      async save(): Promise<SyncResult> { return "ok"; },
      async pushSave(): Promise<SyncResult> { return "ok"; },
      async saveScoped(): Promise<SyncResult> { throw new Error("index.lock"); },
      async syncReadonly(): Promise<void> {},
    };
    const s = new SyncScheduler({ engine, writableRoots: () => ["/team"], readonlyRoots: () => [], clock: new FakeClock() });
    await expect(s.saveScoped("/team", "activity/", "x")).resolves.toBeUndefined();
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
      async save(): Promise<SyncResult> {
        return "ok";
      },
      async pushSave(): Promise<SyncResult> {
        return "ok";
      },
      async saveScoped(): Promise<SyncResult> {
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

  it("does not crash when one root's save throws, and surfaces it as needing attention", async () => {
    const calls: string[] = [];
    const engine = {
      async checkpoint(): Promise<CheckpointResult> {
        return "committed";
      },
      async receive(): Promise<ReceiveResult> {
        return "ok";
      },
      async save(dir: string): Promise<SyncResult> {
        calls.push(dir);
        if (dir === "/bad") throw new Error("network error");
        return "ok";
      },
      async pushSave(): Promise<SyncResult> {
        return "ok";
      },
      async saveScoped(): Promise<SyncResult> {
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
    const status = await scheduler.saveAll();
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
    expect(engine.calls.save).toEqual([]);
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
    expect(engine.calls.save).toEqual([]);
    expect(engine.calls.pushSave).toEqual([]);
  });

  it("sends everything only when the operator asks", async () => {
    const { scheduler, engine } = makeScheduler();
    expect(await scheduler.saveAll()).toBe("ok");
    expect(engine.calls.save).toEqual(["/w/team", "/w/private"]);
  });

  it("never sends core, which is read-only", async () => {
    const { scheduler, engine } = makeScheduler();
    scheduler.touch("/w/core");
    await scheduler.saveAll();
    expect(engine.calls.checkpoint).not.toContain("/w/core");
    expect(engine.calls.save).not.toContain("/w/core");
  });

  it("records but does not send on shutdown - quitting must not publish", async () => {
    const { scheduler, engine } = makeScheduler();
    scheduler.touch("/w/team");
    scheduler.stop();
    await Promise.resolve();
    expect(engine.calls.save).toEqual([]);
    expect(engine.calls.pushSave).toEqual([]);
  });

  it("retries a save that failed while offline", async () => {
    const { scheduler, engine, clock } = makeScheduler();
    engine.saveResult = "queued";
    expect(await scheduler.saveAll()).toBe("queued");
    await clock.advance(5_000);
    await tick();
    expect(engine.calls.pushSave.length).toBeGreaterThan(0); // the named saves went out on the retry
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
        async save(): Promise<SyncResult> {
          order.push("save");
          return "ok";
        },
        async pushSave(): Promise<SyncResult> {
          order.push("push-save");
          return "ok";
        },
        async saveScoped(): Promise<SyncResult> {
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
    expect(order).not.toContain("save");
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
        save: () => slow<SyncResult>("ok"),
        pushSave: () => slow<SyncResult>("ok"),
        saveScoped: () => slow<SyncResult>("ok"),
        async syncReadonly(): Promise<void> {},
      },
      writableRoots: () => ["/w/team"],
      readonlyRoots: () => [],
      clock,
    });
    scheduler.start();
    const publishP = scheduler.saveAll(); // operator saves...
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
    // send what they asked to send - not everything they have done since. The retry is a PUSH of
    // the named save (never a fresh squash), so newer checkpoints cannot ride along.
    const { scheduler, engine, clock } = makeScheduler();
    engine.saveResults = ["ok", "queued"]; // /w/team went out; /w/private was offline
    await scheduler.saveAll();
    expect(engine.calls.checkpoint).toEqual([]); // nothing was dirty at click time

    // The operator keeps working. This touch is still inside its 2s quiet window when the 5s
    // backoff fires, so a retry that flushed would checkpoint it and then send it.
    clock.advance(4_000);
    scheduler.touch("/w/team");

    clock.advance(1_000); // connectivity returns; the retry fires at t=5s
    await tick();
    expect(engine.calls.pushSave).toEqual(["/w/private"]); // only the root that was still pending
    expect(engine.calls.save).toEqual(["/w/team", "/w/private"]); // no re-squash on the retry
    expect(engine.calls.checkpoint).toEqual([]); // and nothing newer was recorded to be sent
  });

  it("gives up retrying while offline instead of re-running forever, leaving the state queued", async () => {
    const { scheduler, engine, clock, statuses } = makeScheduler();
    engine.saveResult = "queued";
    engine.pushSaveResult = "queued";
    await scheduler.saveAll();
    for (let i = 0; i < 12; i++) {
      clock.advance(200_000); // well past every doubling delay
      await tick();
    }
    // 1 initial attempt + at most MAX_RETRIES (5) push retries, over 2 roots.
    expect(engine.calls.save.length + engine.calls.pushSave.length).toBeLessThanOrEqual(12);
    expect(statuses[statuses.length - 1]).toBe("queued"); // the operator can save again by hand
  });

  it("signals busy the instant the operator saves, even while a background tick holds the lease", async () => {
    // A save shares the per-root lease with the background receive tick. If the tick is mid network
    // op, saveAll's flush queues behind it and can stall for seconds. The operator must see their
    // click register immediately - the dot must go busy now, not only once the tick's receive returns.
    const clock = new FakeClock();
    const releaseReceive: (() => void)[] = [];
    const engine = {
      async checkpoint(): Promise<CheckpointResult> {
        return "committed";
      },
      receive: (): Promise<ReceiveResult> =>
        new Promise<ReceiveResult>((r) => releaseReceive.push(() => r("ok"))), // holds the lease open
      async save(): Promise<SyncResult> {
        return "ok";
      },
      async pushSave(): Promise<SyncResult> {
        return "ok";
      },
      async saveScoped(): Promise<SyncResult> {
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

    const publishP = scheduler.saveAll(); // operator clicks Save while the tick is mid-flight
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
    engine.saveResult = "queued";
    expect(await scheduler.saveAll()).toBe("queued"); // arms the 5s backoff retry
    scheduler.stop();
    clock.advance(30_000); // well past the 5s backoff - if the retry survived, it would fire in here
    await tick();
    expect(engine.calls.pushSave).toEqual([]); // no retry push after stop
  });
});

describe("saveResultStatus", () => {
  // Pins the POST /api/sync mapping for every SyncStatus. The regression this guards: a revoked
  // account's saveAll() resolving to "reconnect" must never be reported back to the operator's
  // explicit "Save now" as a false "ok" - the old inline ternary in wiring.ts had no reconnect
  // branch and silently fell through to "ok".
  it("passes needs-help, reconnect, queued and local straight through", () => {
    expect(saveResultStatus("needs-help")).toBe("needs-help");
    expect(saveResultStatus("reconnect")).toBe("reconnect"); // the regression this fixes
    expect(saveResultStatus("queued")).toBe("queued");
    expect(saveResultStatus("local")).toBe("local");
  });

  it("collapses ok and busy to ok", () => {
    expect(saveResultStatus("ok")).toBe("ok");
    expect(saveResultStatus("busy")).toBe("ok"); // saveAll() never actually returns "busy"
  });

  it("covers every SyncStatus member - fails to compile if a new one is added and unhandled", () => {
    const all: SyncStatus[] = ["ok", "busy", "queued", "needs-help", "reconnect", "local"];
    for (const s of all) {
      expect(() => saveResultStatus(s)).not.toThrow();
    }
  });
});
