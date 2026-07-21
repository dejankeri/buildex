import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore, type ScheduleDef, CADENCE_MS } from "./schedule-store.js";

const CO = "co_1";
function freshStore(startMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "sched-"));
  let now = startMs;
  let n = 0;
  const store = new ScheduleStore(join(dir, "control.db"), () => now, () => `run_${++n}`);
  return { store, tick: (ms: number) => (now += ms), setNow: (ms: number) => (now = ms) };
}
const daily: ScheduleDef = { name: "digest", verb: "daily-digest", cadence: "daily", enabled: true, catchUp: "coalesce" };

describe("ScheduleStore reconcile + coalesce", () => {
  it("creates exactly one due-run and advances next_fire_at past now, even across many missed ticks", () => {
    const { store, tick } = freshStore(1_000);
    store.reconcile(CO, [daily]);
    // Not yet due (next_fire_at === now on first sight → due immediately). Move to well past several days.
    tick(CADENCE_MS.daily * 3 + 5);
    const first = store.createDueRuns(CO);
    expect(first).toHaveLength(1);
    expect(first[0]!.verb).toBe("daily-digest");
    // A second create in the same window makes no new run (one is still open).
    expect(store.createDueRuns(CO)).toHaveLength(0);
    // next_fire_at is strictly in the future.
    expect(store.nextFireAt(CO, "digest")!).toBeGreaterThan(1_000 + CADENCE_MS.daily * 3 + 5);
  });

  it("prunes a schedule that disappears from defs, cascading its runs", () => {
    const { store } = freshStore(1_000);
    store.reconcile(CO, [daily]);
    // Seed a run so the prune's DELETE FROM automation_runs cascade is actually exercised.
    expect(store.createDueRuns(CO)).toHaveLength(1);
    store.reconcile(CO, []);
    expect(store.listRuns(CO)).toEqual([]);
    expect(store.nextFireAt(CO, "digest")).toBeNull();
  });

  it("disabling a schedule cancels its outstanding 'due' run but leaves a different schedule's 'claimed' run alone", () => {
    const { store, tick } = freshStore(1_000);
    const other: ScheduleDef = { name: "other", verb: "other-verb", cadence: "daily", enabled: true, catchUp: "coalesce" };
    store.reconcile(CO, [daily, other]);
    tick(CADENCE_MS.daily + 5);
    const created = store.createDueRuns(CO);
    expect(created).toHaveLength(2); // one 'due' run per schedule
    const digestRun = created.find((r) => r.scheduleName === "digest")!;
    const otherRun = created.find((r) => r.scheduleName === "other")!;
    // Put the other schedule's run in-flight so we can prove it's untouched by disabling digest.
    store.claim(CO, otherRun.id, "m", 600_000);

    // Disable "digest" only; "other" stays enabled.
    store.reconcile(CO, [{ ...daily, enabled: false }, other]);

    expect(store.listRuns(CO, "due").find((r) => r.id === digestRun.id)).toBeUndefined();
    expect(store.getRun(CO, otherRun.id)!.state).toBe("claimed"); // untouched - it's in-flight
  });

  it("coalesce backstop: a still-open run blocks a new one even after the schedule comes due again", () => {
    const { store, tick } = freshStore(1_000);
    store.reconcile(CO, [daily]);
    tick(CADENCE_MS.daily + 5);
    const first = store.createDueRuns(CO);
    expect(first).toHaveLength(1);
    // Leave the run open (still 'due') - do NOT report it. Advance past another full cadence so
    // next_fire_at is due again; the coalesce guarantee must hold via hasOpenRun, not merely
    // because next_fire_at hasn't rolled over yet.
    tick(CADENCE_MS.daily);
    const second = store.createDueRuns(CO);
    expect(second).toHaveLength(0);
    expect(store.listRuns(CO, "due")).toHaveLength(1);
  });
});

const eachDaily: ScheduleDef = { name: "each", verb: "d", cadence: "daily", enabled: true, catchUp: "each" };

describe("ScheduleStore each/backlog, claim, report, reap", () => {
  it("each: one run per missed slot, bounded by backlogCap", () => {
    const { store, tick } = freshStore(0);
    store.reconcile(CO, [eachDaily]);
    tick(CADENCE_MS.daily * 10); // 10 slots missed
    const created = store.createDueRuns(CO, { backlogCap: 4 });
    expect(created).toHaveLength(4); // capped
    expect(store.nextFireAt(CO, "each")!).toBeGreaterThan(CADENCE_MS.daily * 10);
  });

  it("claim is atomic: only the first machine wins", () => {
    const { store, tick } = freshStore(0);
    store.reconcile(CO, [daily]);
    tick(CADENCE_MS.daily + 1);
    const [run] = store.createDueRuns(CO);
    const a = store.claim(CO, run!.id, "machine-a", 600_000);
    const b = store.claim(CO, run!.id, "machine-b", 600_000);
    expect(a?.claimedBy).toBe("machine-a");
    expect(b).toBeNull();
  });

  it("report moves a claimed run to done and records the session", () => {
    const { store, tick } = freshStore(0);
    store.reconcile(CO, [daily]);
    tick(CADENCE_MS.daily + 1);
    const [run] = store.createDueRuns(CO);
    store.claim(CO, run!.id, "m", 600_000);
    const done = store.report(CO, run!.id, { state: "done", sessionId: "sess_9" });
    expect(done).toMatchObject({ state: "done", sessionId: "sess_9" });
  });

  it("reap requeues an expired lease, then fails it after maxAttempts", () => {
    const { store, tick } = freshStore(0);
    store.reconcile(CO, [daily]);
    tick(CADENCE_MS.daily + 1);
    const [run] = store.createDueRuns(CO);
    // attempt 1: claim, let it expire, reap → requeued
    store.claim(CO, run!.id, "m", 1000);
    tick(2000);
    expect(store.reap(CO, { maxAttempts: 3 })).toEqual({ requeued: 1, failed: 0 });
    expect(store.getRun(CO, run!.id)!.state).toBe("due");
    // attempt 2 → requeued, attempt 3 → failed
    store.claim(CO, run!.id, "m", 1000); tick(2000);
    expect(store.reap(CO, { maxAttempts: 3 })).toEqual({ requeued: 1, failed: 0 });
    store.claim(CO, run!.id, "m", 1000); tick(2000);
    expect(store.reap(CO, { maxAttempts: 3 })).toEqual({ requeued: 0, failed: 1 });
    expect(store.getRun(CO, run!.id)!.state).toBe("failed");
  });

  it("report tolerates a reaped run: a late done-report after reap→due still lands, not re-dispatched/failed", () => {
    const { store, tick } = freshStore(0);
    store.reconcile(CO, [daily]);
    tick(CADENCE_MS.daily + 1);
    const [run] = store.createDueRuns(CO);
    // Claim with a short lease, let it expire, and reap - the run is back to 'due' (as if another
    // machine could reclaim it), simulating a long verb that outlived its lease.
    store.claim(CO, run!.id, "m", 1000);
    tick(2000);
    expect(store.reap(CO, { maxAttempts: 3 })).toEqual({ requeued: 1, failed: 0 });
    expect(store.getRun(CO, run!.id)!.state).toBe("due");
    // The original machine's verb finally finishes and reports done - it must land as done, not
    // 409/dropped, even though the run is no longer 'claimed'.
    const done = store.report(CO, run!.id, { state: "done", sessionId: "sess_late" });
    expect(done).toMatchObject({ state: "done", sessionId: "sess_late" });
    expect(store.getRun(CO, run!.id)!.state).toBe("done");
  });

  it("isolates companies: createDueRuns for co_1 never returns co_2 runs", () => {
    const { store, tick } = freshStore(0);
    store.reconcile("co_1", [daily]);
    store.reconcile("co_2", [daily]);
    tick(CADENCE_MS.daily + 1);
    const c1 = store.createDueRuns("co_1");
    expect(c1.every((r) => r.companyId === "co_1")).toBe(true);
    expect(store.listRuns("co_2", "due")).toHaveLength(0); // not yet created for co_2
  });
});

describe("ScheduleStore.close", () => {
  it("releases the database file so the directory can be removed", () => {
    // On Windows an open handle blocks rmSync outright; POSIX allows unlinking an open file, which
    // is why a leaked store went unnoticed here for so long.
    const { store } = freshStore(1_000);
    expect(() => store.close()).not.toThrow();
  });

  it("is idempotent, like ControlPlaneStore.close", () => {
    // Teardown closes several stores in sequence; a second call - a retried cleanup, or an afterEach
    // running after a failed beforeEach - must not throw and mask the real failure.
    const { store } = freshStore(1_000);
    store.close();
    expect(() => store.close()).not.toThrow();
    expect(() => {
      store.close();
      store.close();
    }).not.toThrow();
  });
});
