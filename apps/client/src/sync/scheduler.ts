// Background sync loop.
// Owns *when* a sync runs; the SyncEngine primitive owns *how*. Debounces bursts of edits into a
// single commit, runs a background pull tick, retries offline commits with backoff. Deterministic:
// all timing goes through an injected clock so tests run on a fake clock with no real timers.
import type { SyncResult } from "./engine.js";

export type SyncStatus = "ok" | "busy" | "queued" | "needs-help" | "local";

/** Opaque timer id. Numeric for the fake test clock; the real clock casts its setTimeout handle. */
export type TimerHandle = number;

export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(id: TimerHandle): void;
}

export interface SyncEngineLike {
  syncWritable(dir: string): Promise<SyncResult>;
}

export interface SyncSchedulerDeps {
  engine: SyncEngineLike;
  /** The writable (non-`core`) repo dirs - the only roots the loop may sync. */
  writableRoots: () => string[];
  clock: Clock;
  onStatus?: (s: SyncStatus) => void;
  regenConfig?: () => void;
}

const QUIET_MS = 2000;
const MAX_WAIT_MS = 10000;
const BACKOFF_MS = 5000;
const PULL_MS = 45000;

export class SyncScheduler {
  private readonly dirty = new Set<string>();
  private debounceTimer: TimerHandle | null = null;
  private maxWaitTimer: TimerHandle | null = null;
  private backoffTimer: TimerHandle | null = null;
  private pullTimer: TimerHandle | null = null;
  // Serialize flushes: sync is now async (git runs off the event loop), so two flushes could otherwise
  // overlap and race on the same repo's index/push. While one runs, a second request just marks
  // `rerun`; the in-flight flush loops once more when it finishes to pick up the newly-dirtied roots.
  private flushing = false;
  private rerun = false;
  private lastStatus: SyncStatus = "ok";

  constructor(private readonly deps: SyncSchedulerDeps) {}

  /** Begin the background pull tick - fetch/rebase every writable root on an idle interval. */
  start(): void {
    this.schedulePull();
  }

  private schedulePull(): void {
    this.pullTimer = this.deps.clock.setTimer(() => {
      this.schedulePull(); // keep ticking
      for (const dir of this.deps.writableRoots()) this.dirty.add(dir);
      void this.flush();
    }, PULL_MS);
  }

  /** Flush any pending work and halt every timer - call on app shutdown so no edit is stranded. The
   *  final flush is fire-and-forget (sync is async now); any commit it makes is already on local disk
   *  and is pushed on the next boot if the process exits first (the offline queue). */
  stop(): void {
    this.clearAllTimers();
    if (this.dirty.size > 0) void this.flush();
    this.clearAllTimers(); // a final flush may arm a backoff retry; we are quitting, so drop it
  }

  private clearAllTimers(): void {
    for (const t of [this.debounceTimer, this.maxWaitTimer, this.backoffTimer, this.pullTimer]) {
      if (t !== null) this.deps.clock.clearTimer(t);
    }
    this.debounceTimer = this.maxWaitTimer = this.backoffTimer = this.pullTimer = null;
  }

  /** A write landed in `dir` - schedule a sync, coalescing rapid consecutive touches. */
  touch(dir: string): void {
    if (!this.deps.writableRoots().includes(dir)) return; // core is read-only - never sync it
    this.dirty.add(dir);
    // Trailing debounce: each touch pushes the flush out, collapsing a burst into one commit.
    if (this.debounceTimer !== null) this.deps.clock.clearTimer(this.debounceTimer);
    this.debounceTimer = this.deps.clock.setTimer(() => this.flush(), QUIET_MS);
    // Starvation guard: a continuous stream still flushes at least every MAX_WAIT_MS.
    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = this.deps.clock.setTimer(() => this.flush(), MAX_WAIT_MS);
    }
  }

  /** Force an immediate sync of every writable root (powers POST /api/sync). */
  async flushNow(): Promise<SyncStatus> {
    for (const dir of this.deps.writableRoots()) this.dirty.add(dir);
    return this.flush();
  }

  private async flush(): Promise<SyncStatus> {
    // If a flush is already running, coalesce: mark for a re-run and return the last known status.
    // The in-flight flush will loop once it completes and pick up the roots dirtied in the meantime.
    if (this.flushing) {
      this.rerun = true;
      return this.lastStatus;
    }
    this.flushing = true;
    try {
      if (this.debounceTimer !== null) this.deps.clock.clearTimer(this.debounceTimer);
      if (this.maxWaitTimer !== null) this.deps.clock.clearTimer(this.maxWaitTimer);
      this.debounceTimer = null;
      this.maxWaitTimer = null;
      const roots = [...this.dirty];
      this.dirty.clear();
      if (roots.length === 0) return this.lastStatus;
      this.deps.onStatus?.("busy");
      this.deps.regenConfig?.();
      // A thrown sync (non-repo, cloud-synced folder) must never crash the loop - the file is already
      // saved on disk. The engine converts offline/wedged into "queued" internally; only config errors
      // throw. Roots sync concurrently (each is a distinct repo, so no cross-root race).
      const results = await Promise.all(
        roots.map(async (dir): Promise<SyncResult> => {
          try {
            return await this.deps.engine.syncWritable(dir);
          } catch {
            return "no-change";
          }
        }),
      );
      const status = worstStatus(results);
      this.lastStatus = status;
      this.deps.onStatus?.(status);

      // Offline roots (their commits are retained locally by the engine) get retried after a delay.
      const queued = roots.filter((_, i) => results[i] === "queued");
      if (this.backoffTimer !== null) this.deps.clock.clearTimer(this.backoffTimer);
      this.backoffTimer = null;
      if (queued.length > 0) {
        this.backoffTimer = this.deps.clock.setTimer(() => {
          this.backoffTimer = null;
          for (const dir of queued) this.dirty.add(dir);
          void this.flush();
        }, BACKOFF_MS);
      }
      return status;
    } finally {
      this.flushing = false;
      // A flush was requested while we were running - run once more to drain the new work.
      if (this.rerun) {
        this.rerun = false;
        void this.flush();
      }
    }
  }
}

/** Collapse per-root results into the one status the sync dot should show (worst wins). "local"
 *  (no remote - nothing to sync) ranks below the real problems but above "ok", so a local-only
 *  workspace shows the neutral not-synced state rather than a misleading green "Synced". */
function worstStatus(results: SyncResult[]): SyncStatus {
  if (results.includes("needs-help")) return "needs-help";
  if (results.includes("queued")) return "queued";
  if (results.includes("local")) return "local";
  return "ok";
}
