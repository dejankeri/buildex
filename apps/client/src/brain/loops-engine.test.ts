// The scheduler, with the clock and the agent both injected - so every firing rule is asserted
// without a real timer or a real spawn. What is being pinned here is restraint: one run per window,
// never two of the same loop, never more than a couple at once, and a stale window recorded rather
// than run.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopsEngine } from "./loops-engine.js";
import { LoopDefStore, LoopStateFile, type LoopDef } from "./loops.js";

let dir: string;
let defs: LoopDefStore;
let state: LoopStateFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loops-engine-"));
  defs = new LoopDefStore(join(dir, "loops.yaml"));
  state = new LoopStateFile(join(dir, "state.json"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const T0 = new Date(2026, 6, 23, 9, 0, 0).getTime(); // a Thursday, 9am local

/** A run recorder standing in for the agent: records each spawn, resolves when the test says so. */
function recorder() {
  const started: string[] = [];
  const pending: Array<{ name: string; finish: (r?: { blockedOn?: string }) => void; fail: (e: Error) => void }> = [];
  let seq = 0;
  const run = (loop: LoopDef) => {
    started.push(loop.name);
    const sessionId = `s${++seq}`;
    let finish!: (r?: { blockedOn?: string }) => void;
    let fail!: (e: Error) => void;
    const done = new Promise<{ blockedOn?: string }>((res, rej) => {
      finish = (r) => res(r ?? {});
      fail = rej;
    });
    pending.push({ name: loop.name, finish, fail });
    return Promise.resolve({ sessionId, done });
  };
  const finishAll = () => {
    const all = pending.splice(0);
    for (const p of all) p.finish();
    return Promise.resolve();
  };
  return { started, pending, run, finishAll };
}

function engineWith(rec: ReturnType<typeof recorder>, now: () => number, maxConcurrent?: number) {
  return new LoopsEngine({ defs, state, now, run: rec.run, ...(maxConcurrent ? { maxConcurrent } : {}) });
}

describe("LoopsEngine — firing", () => {
  it("does not fire a brand-new loop on the tick that first sees it", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now);
    defs.add({ title: "Sweep", prompt: "sweep", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    await engine.tick();
    expect(rec.started).toEqual([]);

    now = T0 + HOUR;
    await engine.tick();
    expect(rec.started).toEqual(["sweep"]);
  });

  it("fires once per window, not once per tick", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now);
    defs.add({ title: "Sweep", prompt: "sweep", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    await engine.tick(); // stamps firstSeen

    now = T0 + HOUR;
    await engine.tick();
    await rec.finishAll();
    await engine.settled();
    now += 60_000;
    await engine.tick();
    now += 60_000;
    await engine.tick();

    expect(rec.started).toEqual(["sweep"]);
  });

  it("never starts a second run of a loop whose first run is still going", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now);
    defs.add({ title: "Slow", prompt: "slow", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    await engine.tick();

    now = T0 + HOUR;
    await engine.tick(); // starts, never finishes
    now = T0 + 5 * HOUR;
    await engine.tick();
    await engine.tick();

    expect(rec.started).toEqual(["slow"]);
  });

  it("collapses the windows a closed laptop slept through into a single run", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now);
    defs.add({ title: "Sweep", prompt: "sweep", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    await engine.tick();

    now = T0 + 9 * HOUR; // nine windows elapsed while the app was shut
    await engine.tick();
    await rec.finishAll();
    await engine.settled();
    await engine.tick();

    expect(rec.started).toEqual(["sweep"]);
  });

  it("holds the third loop back when two are already running", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now, 2);
    for (const t of ["A", "B", "C"]) defs.add({ title: t, prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    await engine.tick();

    now = T0 + HOUR;
    await engine.tick();
    expect(rec.started).toEqual(["a", "b"]);

    await rec.finishAll();
    await engine.settled();
    await engine.tick();
    expect(rec.started).toEqual(["a", "b", "c"]);
  });

  it("skips a disabled loop", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now);
    defs.add({ title: "Off", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" }, enabled: false });
    await engine.tick();
    now = T0 + 5 * HOUR;
    await engine.tick();
    expect(rec.started).toEqual([]);
  });

  it("records a stale time-of-day window as missed instead of running it at the wrong hour", async () => {
    const rec = recorder();
    let now = new Date(2026, 6, 22, 20, 0).getTime(); // created the evening before
    const engine = engineWith(rec, () => now);
    defs.add({ title: "Standup", prompt: "draft it", schedule: { kind: "at", hour: 9, minute: 0, days: [] } });
    await engine.tick();

    now = new Date(2026, 6, 23, 20, 0).getTime(); // laptop opened eleven hours after the window
    await engine.tick();

    expect(rec.started).toEqual([]);
    expect(state.get("standup")?.status).toBe("missed");

    // ...and the missed window is not reconsidered on the next tick.
    now += 60_000;
    await engine.tick();
    expect(rec.started).toEqual([]);
  });
});

describe("LoopsEngine — run bookkeeping", () => {
  it("records the session and an ok status when a run completes", async () => {
    const rec = recorder();
    const now = T0;
    const engine = engineWith(rec, () => now);
    defs.add({ title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    const started = await engine.runNow("sweep");
    expect(started).toEqual({ sessionId: "s1" });
    expect(state.get("sweep")?.status).toBe("running");

    await rec.finishAll();
    await engine.settled();
    expect(state.get("sweep")).toMatchObject({ status: "ok", sessionId: "s1", lastRun: now });
  });

  it("records a failed run and still stamps it, so a broken loop cannot spawn an agent every tick", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now);
    defs.add({ title: "Broken", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    await engine.tick();

    now = T0 + HOUR;
    await engine.tick();
    rec.pending[0]!.fail(new Error("agent exited 1"));
    await engine.settled();

    expect(state.get("broken")).toMatchObject({ status: "failed", lastRun: now });
    now += 60_000;
    await engine.tick();
    expect(rec.started).toEqual(["broken"]);
  });

  it("records what a run needed a human for", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    defs.add({ title: "Mailer", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    await engine.runNow("mailer");
    rec.pending[0]!.finish({ blockedOn: "send an email to the team" });
    await engine.settled();

    expect(state.get("mailer")).toMatchObject({ status: "needs-approval", blockedOn: "send an email to the team" });
  });

  it("clears the old blocker when the loop is run again", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    defs.add({ title: "Mailer", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    await engine.runNow("mailer");
    rec.pending[0]!.finish({ blockedOn: "send an email" });
    await engine.settled();

    await engine.runNow("mailer");
    await rec.finishAll();
    await engine.settled();

    expect(state.get("mailer")?.status).toBe("ok");
    expect(state.get("mailer")?.blockedOn).toBeUndefined();
  });

  it("refuses a second manual run while one is in flight", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    defs.add({ title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    await engine.runNow("sweep");
    await expect(engine.runNow("sweep")).rejects.toThrow(/already running/i);
    expect(rec.started).toEqual(["sweep"]);
  });

  it("refuses to run a loop that does not exist", async () => {
    const engine = engineWith(recorder(), () => T0);
    await expect(engine.runNow("ghost")).rejects.toThrow(/not found/i);
  });

  it("runs a disabled loop on demand - the toggle is about the schedule, not the button", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    defs.add({ title: "Off", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" }, enabled: false });
    await engine.runNow("off");
    expect(rec.started).toEqual(["off"]);
  });
});

describe("LoopsEngine — the view the console renders", () => {
  it("carries the schedule sentence and the next run", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    defs.add({ title: "Weekly review", prompt: "p", schedule: { kind: "at", hour: 9, minute: 0, days: ["mon"] } });

    const [view] = engine.list();
    expect(view).toMatchObject({
      name: "weekly-review",
      title: "Weekly review",
      scheduleText: "every Monday at 9:00 AM",
    });
    expect(view!.nextRun).toBe(new Date(2026, 6, 27, 9, 0).getTime());
  });

  it("reports a loop as running while its agent is in flight", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    defs.add({ title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    await engine.runNow("sweep");
    expect(engine.list()[0]!.status).toBe("running");
    await rec.finishAll();
    await engine.settled();
    expect(engine.list()[0]!.status).toBe("ok");
  });

  it("forgets the state of a loop the operator deleted", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    defs.add({ title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    await engine.runNow("sweep");
    await rec.finishAll();
    await engine.settled();

    engine.remove("sweep");
    await engine.tick();
    expect(state.get("sweep")).toBeUndefined();
  });

  it("toggles a loop without disturbing its run state", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    defs.add({ title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    await engine.runNow("sweep");
    await rec.finishAll();
    await engine.settled();

    expect(engine.toggle("sweep").enabled).toBe(false);
    expect(engine.list()[0]!.status).toBe("ok");
    expect(engine.toggle("sweep").enabled).toBe(true);
  });
});
