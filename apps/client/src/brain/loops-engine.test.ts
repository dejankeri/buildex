// The scheduler, with the clock and the agent both injected - so every firing rule is asserted
// without a real timer or a real spawn. What is being pinned here is restraint: one run per window,
// never two of the same loop, never more than a couple at once, and a stale window recorded rather
// than run.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopsEngine, type RunOutcome } from "./loops-engine.js";
import { LoopRunsFile } from "./loops-runs.js";
import { LoopDefStore, LoopStateFile, type LoopDef } from "./loops.js";

let dir: string;
let defs: LoopDefStore;
let state: LoopStateFile;
let runs: LoopRunsFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loops-engine-"));
  defs = new LoopDefStore(join(dir, "loops.yaml"));
  state = new LoopStateFile(join(dir, "state.json"));
  runs = new LoopRunsFile(join(dir, "runs.json"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const T0 = new Date(2026, 6, 23, 9, 0, 0).getTime(); // a Thursday, 9am local

/** A run recorder standing in for the agent: records each spawn, resolves when the test says so. */
function recorder() {
  const started: string[] = [];
  const pending: Array<{ name: string; finish: (r?: RunOutcome) => void; fail: (e: Error) => void }> = [];
  let seq = 0;
  const run = (loop: LoopDef) => {
    started.push(loop.name);
    const sessionId = `s${++seq}`;
    let finish!: (r?: RunOutcome) => void;
    let fail!: (e: Error) => void;
    const done = new Promise<RunOutcome>((res, rej) => {
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
  return new LoopsEngine({ defs, state, runs, now, run: rec.run, ...(maxConcurrent ? { maxConcurrent } : {}) });
}

/** Define a loop AND adopt it on this machine - what creating one through the console does. Tests
 *  about firing want a loop this machine actually runs; the machine-scope tests below skip this. */
function seed(engine: LoopsEngine, input: Parameters<LoopDefStore["add"]>[0]) {
  const def = defs.add(input);
  engine.setActiveHere(def.name, true);
  return def;
}

describe("LoopsEngine — firing", () => {
  it("does not fire a brand-new loop on the tick that first sees it", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now);
    seed(engine, { title: "Sweep", prompt: "sweep", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

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
    seed(engine, { title: "Sweep", prompt: "sweep", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
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
    seed(engine, { title: "Slow", prompt: "slow", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
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
    seed(engine, { title: "Sweep", prompt: "sweep", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
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
    for (const t of ["A", "B", "C"]) seed(engine, { title: t, prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
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
    seed(engine, { title: "Off", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" }, enabled: false });
    await engine.tick();
    now = T0 + 5 * HOUR;
    await engine.tick();
    expect(rec.started).toEqual([]);
  });

  it("records a stale time-of-day window as missed instead of running it at the wrong hour", async () => {
    const rec = recorder();
    let now = new Date(2026, 6, 22, 20, 0).getTime(); // created the evening before
    const engine = engineWith(rec, () => now);
    seed(engine, { title: "Standup", prompt: "draft it", schedule: { kind: "at", hour: 9, minute: 0, days: [] } });
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

describe("LoopsEngine — machine scope", () => {
  // loops.yaml is COMMITTED, so a definition reaches every machine in the company. If every machine
  // fired it, two open laptops would mean two Monday updates and two emails. Adoption is per machine
  // and off by default; the only loop active without a tap is one created right here.
  it("does not fire a loop this machine has not adopted, however overdue", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now);
    defs.add({ title: "Theirs", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } }); // arrived by sync

    now = T0 + 100 * HOUR;
    await engine.tick();
    await engine.tick();
    expect(rec.started).toEqual([]);
    expect(engine.list()[0]!.activeHere).toBe(false);
  });

  it("adopts a loop created here, without a tap", () => {
    const engine = engineWith(recorder(), () => T0);
    const view = engine.add({ title: "Mine", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    expect(view.activeHere).toBe(true);
  });

  it("starts firing once adopted, and stops when the machine drops it", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now);
    defs.add({ title: "Theirs", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    engine.setActiveHere("theirs", true);
    now = T0 + HOUR;
    await engine.tick();
    expect(rec.started).toEqual(["theirs"]);
    await rec.finishAll();
    await engine.settled();

    engine.setActiveHere("theirs", false);
    now = T0 + 10 * HOUR;
    await engine.tick();
    expect(rec.started).toEqual(["theirs"]); // no second run
  });

  it("adopting a loop that ran long ago elsewhere waits a full window instead of firing at once", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now);
    defs.add({ title: "Theirs", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    // Its last run came from another machine, months back - the shared file knows, this machine doesn't.
    state.set("theirs", { lastRun: T0 - 60 * 24 * HOUR });

    engine.setActiveHere("theirs", true);
    await engine.tick();
    expect(rec.started).toEqual([]); // NOT instantly due despite a two-month-old lastRun

    now = T0 + HOUR;
    await engine.tick();
    expect(rec.started).toEqual(["theirs"]);
  });

  it("runs on demand even when this machine has not adopted it - the button is not the schedule", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    defs.add({ title: "Theirs", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    await engine.runNow("theirs");
    expect(rec.started).toEqual(["theirs"]);
    expect(engine.list()[0]!.activeHere).toBe(false); // one manual run does not adopt it
  });

  it("refuses to adopt a loop that does not exist", () => {
    const engine = engineWith(recorder(), () => T0);
    expect(() => engine.setActiveHere("ghost", true)).toThrow(/not found/i);
  });
});

describe("LoopsEngine — run bookkeeping", () => {
  it("records the session and an ok status when a run completes", async () => {
    const rec = recorder();
    const now = T0;
    const engine = engineWith(rec, () => now);
    seed(engine, { title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

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
    seed(engine, { title: "Broken", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
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
    seed(engine, { title: "Mailer", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    await engine.runNow("mailer");
    rec.pending[0]!.finish({ blockedOn: "send an email to the team" });
    await engine.settled();

    expect(state.get("mailer")).toMatchObject({ status: "needs-approval", blockedOn: "send an email to the team" });
  });

  it("clears the old blocker when the loop is run again", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    seed(engine, { title: "Mailer", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

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
    seed(engine, { title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

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
    seed(engine, { title: "Off", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" }, enabled: false });
    await engine.runNow("off");
    expect(rec.started).toEqual(["off"]);
  });
});

describe("LoopsEngine — the view the console renders", () => {
  it("carries the schedule sentence and the next run", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    seed(engine, { title: "Weekly review", prompt: "p", schedule: { kind: "at", hour: 9, minute: 0, days: ["mon"] } });

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
    seed(engine, { title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    await engine.runNow("sweep");
    expect(engine.list()[0]!.status).toBe("running");
    await rec.finishAll();
    await engine.settled();
    expect(engine.list()[0]!.status).toBe("ok");
  });

  it("forgets the state of a loop the operator deleted", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    seed(engine, { title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
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
    seed(engine, { title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    await engine.runNow("sweep");
    await rec.finishAll();
    await engine.settled();

    expect(engine.toggle("sweep").enabled).toBe(false);
    expect(engine.list()[0]!.status).toBe("ok");
    expect(engine.toggle("sweep").enabled).toBe(true);
  });
});

// Only the last run was ever remembered, so three failed mornings showed as one Failed chip. The
// history is what makes a pattern visible - and it is the same ledger the spending limit reads, so
// these tests also pin that a run is never counted in one place and missed in the other.
describe("LoopsEngine — run history", () => {
  it("records each finished run, newest first, with its session and price", async () => {
    const rec = recorder();
    let now = T0;
    const engine = engineWith(rec, () => now);
    seed(engine, { title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    await engine.runNow("sweep");
    rec.pending.splice(0)[0]!.finish({ costUsd: 0.02, ms: 4000 });
    await engine.settled();

    now = T0 + HOUR;
    await engine.runNow("sweep");
    rec.pending.splice(0)[0]!.finish({ costUsd: 0.03, ms: 5000 });
    await engine.settled();

    const history = runs.history("sweep");
    expect(history.map((r) => r.at)).toEqual([T0 + HOUR, T0]);
    expect(history[0]).toMatchObject({ status: "ok", sessionId: "s2", costUsd: 0.03, ms: 5000 });
  });

  it("ships the history inline on list(), so the panel needs no request per card", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    seed(engine, { title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    await engine.runNow("sweep");
    await rec.finishAll();
    await engine.settled();
    expect(engine.list()[0]!.runs.map((r) => r.status)).toEqual(["ok"]);
  });

  it("records a failed run and a blocked one, with what the blocked one wanted", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    seed(engine, { title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });

    await engine.runNow("sweep");
    rec.pending.splice(0)[0]!.fail(new Error("spawn failed"));
    await engine.settled();

    await engine.runNow("sweep");
    rec.pending.splice(0)[0]!.finish({ blockedOn: "send an email to ops@acme.com" });
    await engine.settled();

    const history = runs.history("sweep");
    expect(history[0]).toMatchObject({ status: "needs-approval", blockedOn: "send an email to ops@acme.com" });
    expect(history[1]).toMatchObject({ status: "failed" });
  });

  it("records a window that went cold, so a missed morning is in the history too", async () => {
    const rec = recorder();
    // Switched on at 10am Thursday, so today's 9am window predates the loop and owes nothing.
    let now = new Date(2026, 6, 23, 10, 0, 0).getTime();
    const engine = engineWith(rec, () => now);
    seed(engine, { title: "Standup", prompt: "p", schedule: { kind: "at", hour: 9, minute: 0, days: [] } });
    await engine.tick();
    expect(runs.history("standup")).toEqual([]);

    now = new Date(2026, 6, 24, 20, 0, 0).getTime(); // Friday evening: the 9am window is long cold
    await engine.tick();
    expect(runs.history("standup").map((r) => r.status)).toEqual(["missed"]);
    expect(rec.started).toEqual([]);
  });

  it("forgets a deleted loop's history on the next tick", async () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    seed(engine, { title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    await engine.runNow("sweep");
    await rec.finishAll();
    await engine.settled();

    engine.remove("sweep");
    await engine.tick();
    expect(runs.history("sweep")).toEqual([]);
  });
});

// A loop firing unattended spends the operator's agent budget - the money dimension of invariant 5,
// which just never looked like money because it is compute. The ceiling is the gate.
describe("LoopsEngine — the daily spending limit", () => {
  /** A loop that is due right now, with `spent` already on today's ledger. */
  function overspent(rec: ReturnType<typeof recorder>, spent: number, cap: number) {
    const engine = engineWith(rec, () => T0 + 2 * HOUR);
    const def = defs.add({ title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    state.set(def.name, { activeHere: true, firstSeen: T0 });
    runs.setCap(cap);
    runs.record(def.name, { at: T0, status: "ok", costUsd: spent });
    return engine;
  }

  it("fires as usual while the day is under its ceiling", async () => {
    const rec = recorder();
    expect(await overspent(rec, 0.2, 1).tick()).toEqual(["sweep"]);
  });

  it("stops the clock once the day's ceiling is reached", async () => {
    const rec = recorder();
    expect(await overspent(rec, 1.5, 1).tick()).toEqual([]);
    expect(rec.started).toEqual([]);
  });

  it("stamps nothing while held back, so a held window is judged tomorrow on its own terms", async () => {
    const rec = recorder();
    const engine = overspent(rec, 1.5, 1);
    await engine.tick();
    expect(state.get("sweep")!.status).toBeUndefined();
    expect(state.get("sweep")!.lastRun).toBeUndefined();
  });

  it("still runs on demand over the ceiling - the operator is present, which is the distinction", async () => {
    const rec = recorder();
    const engine = overspent(rec, 1.5, 1);
    await engine.runNow("sweep");
    expect(rec.started).toEqual(["sweep"]);
  });

  it("fires again after midnight, when the day's ledger resets", async () => {
    const rec = recorder();
    let now = T0 + 2 * HOUR;
    const engine = new LoopsEngine({ defs, state, runs, now: () => now, run: rec.run });
    const def = defs.add({ title: "Sweep", prompt: "p", schedule: { kind: "every", ms: HOUR, raw: "1h" } });
    state.set(def.name, { activeHere: true, firstSeen: T0 });
    runs.setCap(1);
    runs.record(def.name, { at: T0, status: "ok", costUsd: 1.5 });

    expect(await engine.tick()).toEqual([]);
    now = new Date(2026, 6, 24, 9, 0, 0).getTime(); // the next local day
    expect(await engine.tick()).toEqual(["sweep"]);
  });

  it("reports today and the month against the ceiling", () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    runs.setCap(2);
    runs.record("sweep", { at: T0, status: "ok", costUsd: 0.25 });
    expect(engine.spend()).toMatchObject({ today: { runs: 1, costUsd: 0.25 }, capUsd: 2, overCap: false });
  });

  it("sets and clears the ceiling", () => {
    const rec = recorder();
    const engine = engineWith(rec, () => T0);
    expect(engine.setCap(5).capUsd).toBe(5);
    expect(engine.setCap(undefined).capUsd).toBeUndefined();
  });
});
