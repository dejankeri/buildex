// The scheduler. Owns exactly one question - which loops should be running right now - and answers
// it from the definitions, the run stamps, and an injected clock. It never touches an agent itself:
// `deps.run` is the seam, so the whole firing policy is testable without a spawn or a timer.
//
// The restraint is the feature. An operator who closes their laptop for a day must come back to one
// run per loop, not a queue of them; a loop whose agent is still working must not be started again;
// and a burst of loops sharing a 9am window must not spawn a fleet at once.
import {
  LoopDefStore,
  LoopStateFile,
  type LoopDef,
  type LoopStatus,
  type NewLoop,
  type LoopSchedule,
} from "./loops.js";
import { dueness, nextFire, scheduleSentence } from "./loops-schedule.js";
import { LoopRunsFile, type LoopRun, type SpendSummary } from "./loops-runs.js";

/** A loop as the console renders it: the definition, its schedule in words, and how it last went. */
export interface LoopView extends LoopDef {
  scheduleText: string;
  /** Whether THIS machine is the one running it. */
  activeHere: boolean;
  nextRun: number;
  lastRun?: number;
  status?: LoopStatus;
  sessionId?: string;
  blockedOn?: string;
  /** The last runs, newest first - the history strip on the card and the ⋯ → history list. Small
   *  enough (RUNS_KEPT) to ship inline, so the panel needs no second request per card. */
  runs: LoopRun[];
}

/** How a run ended. `blockedOn` is set only when the gate TTL-denied with nobody there to tap; the
 *  price is whatever the agent reported, which on a subscription plan is a notional API-rate figure. */
export interface RunOutcome {
  blockedOn?: string;
  costUsd?: number;
  ms?: number;
}

/** A started run: the session exists immediately, the work finishes later. Splitting the two is what
 *  lets "Run now" answer the operator at once instead of holding the request open for the whole run. */
export interface StartedRun {
  sessionId: string;
  done: Promise<RunOutcome>;
}

export interface LoopsEngineDeps {
  defs: LoopDefStore;
  state: LoopStateFile;
  /** What each loop did and what it cost - the history strip, and the ledger the daily limit reads. */
  runs: LoopRunsFile;
  now: () => number;
  run: (loop: LoopDef) => Promise<StartedRun>;
  /** How many loop runs may be in flight at once. Two is enough to keep a slow loop from blocking
   *  the rest, and few enough that a shared 9am window cannot spawn a fleet. */
  maxConcurrent?: number;
}

const DEFAULT_MAX_CONCURRENT = 2;

export class LoopsEngine {
  private readonly running = new Set<string>();
  /** In-flight bookkeeping, so tests (and shutdown) can wait for runs to be recorded. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: LoopsEngineDeps) {}

  list(): LoopView[] {
    const now = this.deps.now();
    const stamps = this.deps.state.all();
    const history = this.deps.runs.all();
    return this.deps.defs.list().map((def) => {
      const st = stamps[def.name] ?? {};
      const firstSeen = st.firstSeen ?? now;
      return {
        ...def,
        scheduleText: scheduleSentence(def.schedule),
        activeHere: st.activeHere === true,
        nextRun: nextFire(def.schedule, { firstSeen, ...(st.lastRun !== undefined ? { lastRun: st.lastRun } : {}) }, now),
        ...(st.lastRun !== undefined ? { lastRun: st.lastRun } : {}),
        ...(this.running.has(def.name) ? { status: "running" as const } : st.status ? { status: st.status } : {}),
        ...(st.sessionId ? { sessionId: st.sessionId } : {}),
        ...(st.blockedOn ? { blockedOn: st.blockedOn } : {}),
        runs: history[def.name] ?? [],
      };
    });
  }

  /** Today's unattended spend against its ceiling, and the month so far. */
  spend(): SpendSummary {
    return this.deps.runs.summary(this.deps.now());
  }

  /** Set (or clear, with undefined) the ceiling on what loops may spend per local day on THIS
   *  machine. Local, because the money is the operator's own agent usage, not the company's file. */
  setCap(usd: number | undefined): SpendSummary {
    this.deps.runs.setCap(usd);
    return this.spend();
  }

  add(input: NewLoop): LoopView {
    const def = this.deps.defs.add(input);
    // Created here, so it runs here - the one case where a loop is active without an explicit tap.
    // Anchored now, so a loop created at 2pm with a 9am window waits for tomorrow instead of firing
    // the moment the next tick sees it.
    this.deps.state.set(def.name, { activeHere: true, firstSeen: this.deps.now() });
    return this.view(def.name);
  }

  /** Switch this machine's participation in a loop on or off. Switching ON re-anchors the clock to
   *  now, so adopting a loop that last ran months ago on someone else's machine does not fire it
   *  instantly - it waits a full window, exactly like a freshly created one. */
  setActiveHere(name: string, active: boolean): LoopView {
    if (!this.deps.defs.list().some((l) => l.name === name)) throw new Error(`loop not found: ${name}`);
    this.deps.state.set(name, active ? { activeHere: true, firstSeen: this.deps.now() } : { activeHere: false });
    return this.view(name);
  }

  update(name: string, patch: { title?: string; prompt?: string; verb?: string; schedule?: LoopSchedule; enabled?: boolean }): LoopView {
    this.deps.defs.update(name, patch);
    return this.view(name);
  }

  toggle(name: string): LoopView {
    const def = this.deps.defs.list().find((l) => l.name === name);
    if (!def) throw new Error(`loop not found: ${name}`);
    this.deps.defs.update(name, { enabled: !def.enabled });
    return this.view(name);
  }

  remove(name: string): void {
    this.deps.defs.remove(name);
  }

  /** Fire a loop on demand. Resolves as soon as its session exists - the run continues behind it.
   *  A disabled loop still runs: the toggle governs the schedule, not the button. */
  async runNow(name: string): Promise<{ sessionId: string }> {
    const def = this.deps.defs.list().find((l) => l.name === name);
    if (!def) throw new Error(`loop not found: ${name}`);
    if (this.running.has(name)) throw new Error(`loop already running: ${name}`);
    return { sessionId: await this.start(def) };
  }

  /** One pass of the clock: stamp new loops, record windows that went cold, start what is due. */
  async tick(): Promise<string[]> {
    const now = this.deps.now();
    const defs = this.deps.defs.list();
    const names = new Set(defs.map((d) => d.name));
    this.deps.state.prune(names);
    this.deps.runs.prune(names, now);

    // Money is one of the three things invariant 5 gates, and a loop spending the operator's agent
    // budget while nobody is watching is exactly that - it just never looked like money because it is
    // compute. Over the ceiling we stop the CLOCK, and stamp nothing: a window that goes cold while
    // held back is recorded missed tomorrow, on its own terms, rather than being written off now.
    // "Run now" is untouched, because the operator is present - that is the whole distinction.
    if (this.deps.runs.overCap(now)) return [];

    const due: LoopDef[] = [];
    for (const def of defs) {
      const st = this.deps.state.get(def.name) ?? {};
      // A loop this machine has not adopted is inert here: no firing, and no stamping either, so
      // switching it on later is what anchors its clock.
      if (st.activeHere !== true) continue;
      if (st.firstSeen === undefined) {
        this.deps.state.set(def.name, { firstSeen: now });
        continue; // never fire on the tick that first sees a loop
      }
      if (!def.enabled || this.running.has(def.name)) continue;

      const verdict = dueness(def.schedule, { firstSeen: st.firstSeen, ...(st.lastRun !== undefined ? { lastRun: st.lastRun } : {}) }, now);
      if (verdict.missed !== undefined) {
        // Move the stamp past the cold window so it is recorded once, not reconsidered every tick.
        this.deps.state.set(def.name, { lastRun: verdict.missed, status: "missed", blockedOn: undefined });
        this.deps.runs.record(def.name, { at: verdict.missed, status: "missed" });
        continue;
      }
      if (verdict.due) due.push(def);
    }

    const started: string[] = [];
    for (const def of due) {
      if (this.running.size >= (this.deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)) break; // the rest wait for the next tick
      await this.start(def);
      started.push(def.name);
    }
    return started;
  }

  /** Wait for every in-flight run to be recorded. For tests and orderly shutdown. */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /** Start a run and hand back its session id; bookkeeping rides on the run's own promise. */
  private async start(def: LoopDef): Promise<string> {
    this.running.add(def.name);
    this.deps.state.set(def.name, { status: "running", blockedOn: undefined });
    let started: StartedRun;
    try {
      started = await this.deps.run(def);
    } catch (err) {
      this.running.delete(def.name);
      this.deps.state.set(def.name, { lastRun: this.deps.now(), status: "failed", blockedOn: undefined });
      // A run that never got a session still happened, and still counts: recorded with no session id
      // (there is no transcript to open) so the history does not quietly skip the failure.
      this.deps.runs.record(def.name, { at: this.deps.now(), status: "failed" });
      throw err;
    }
    const record = started.done
      .then((r) => {
        this.finish(def.name, started.sessionId, r.blockedOn ? "needs-approval" : "ok", r);
      })
      .catch(() => {
        // A failed run is still stamped: without it a broken loop would be due again next tick and
        // would spawn an agent every 30 seconds.
        this.finish(def.name, started.sessionId, "failed", {});
      })
      .finally(() => {
        this.running.delete(def.name);
        this.inflight.delete(record);
      });
    this.inflight.add(record);
    return started.sessionId;
  }

  /** Stamp the loop's current state AND append to its history in one place, so the chip on the card
   *  and the newest row of the strip can never disagree about the same run. */
  private finish(name: string, sessionId: string, status: "ok" | "failed" | "needs-approval", r: RunOutcome): void {
    const at = this.deps.now();
    this.deps.state.set(name, { lastRun: at, status, sessionId, blockedOn: r.blockedOn });
    this.deps.runs.record(name, {
      at,
      status,
      sessionId,
      ...(r.ms !== undefined ? { ms: r.ms } : {}),
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      ...(r.blockedOn !== undefined ? { blockedOn: r.blockedOn } : {}),
    });
  }

  private view(name: string): LoopView {
    const v = this.list().find((l) => l.name === name);
    if (!v) throw new Error(`loop not found: ${name}`);
    return v;
  }
}
