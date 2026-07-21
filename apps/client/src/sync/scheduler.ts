// Background sync loop.
// Owns *when* a sync runs; the SyncEngine primitive owns *how*. Debounces bursts of edits into a
// single commit, runs a background pull tick, retries offline commits with backoff. Deterministic:
// all timing goes through an injected clock so tests run on a fake clock with no real timers.
import type { SyncResult, CheckpointResult, ReceiveResult } from "./engine.js";

export type SyncStatus = "ok" | "busy" | "queued" | "needs-help" | "local";

/** Opaque timer id. Numeric for the fake test clock; the real clock casts its setTimeout handle. */
export type TimerHandle = number;

export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(id: TimerHandle): void;
}

export interface SyncEngineLike {
  checkpoint(dir: string): Promise<CheckpointResult>;
  receive(dir: string): Promise<ReceiveResult>;
  publish(dir: string): Promise<SyncResult>;
  syncReadonly(dir: string): Promise<void>;
}

export interface SyncSchedulerDeps {
  engine: SyncEngineLike;
  /** The writable (non-`core`) roots - the only ones that may be checkpointed or published. */
  writableRoots: () => string[];
  /** Read-only roots (`core`) - pulled on the tick, never sent. */
  readonlyRoots: () => string[];
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
      void this.receiveAll();
    }, PULL_MS);
  }

  /** Take in whatever arrived, in both directions of the workspace. Sends nothing, so this is safe
   *  to run unattended - it is the "other people's work arrives on its own" half of the rule. */
  private async receiveAll(): Promise<void> {
    for (const dir of this.deps.readonlyRoots()) {
      try {
        await this.deps.engine.syncReadonly(dir);
      } catch {
        /* offline or not a repo - core is rebuilt from the remote next tick */
      }
    }
    for (const dir of this.deps.writableRoots()) {
      try {
        const r = await this.deps.engine.receive(dir);
        if (r === "needs-help") this.setStatus("needs-help");
      } catch {
        /* nothing arrived; the operator's own work is untouched */
      }
    }
  }

  /** Record any pending work and halt every timer - call on app shutdown so no edit is stranded.
   *  It does NOT send: saving is the operator's decision, and quitting is not a decision to save.
   *  The checkpoints are on local disk and go out with their next save. */
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

  /** A write landed in `dir` - schedule a checkpoint, coalescing rapid consecutive touches. */
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

  private setStatus(s: SyncStatus): void {
    this.lastStatus = s;
    this.deps.onStatus?.(s);
  }

  /** Record dirty roots locally. NO NETWORK - this is what the debounce runs. */
  private async flush(): Promise<SyncStatus> {
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
      this.deps.regenConfig?.();
      // A throw (non-repo, cloud-synced folder) must never crash the loop - the file is already on
      // disk. Roots are distinct repos, so there is no cross-root race.
      await Promise.all(
        roots.map(async (dir) => {
          try {
            await this.deps.engine.checkpoint(dir);
          } catch {
            /* the operator's file is on disk regardless */
          }
        }),
      );
      return this.lastStatus;
    } finally {
      this.flushing = false;
      if (this.rerun) {
        this.rerun = false;
        void this.flush();
      }
    }
  }

  /** Send everything the operator has. The one path that pushes, and only they trigger it
   *  (POST /api/sync). */
  async publishAll(): Promise<SyncStatus> {
    await this.flush(); // record anything still in the debounce window first
    const roots = this.deps.writableRoots();
    this.setStatus("busy");
    const results = await Promise.all(
      roots.map(async (dir): Promise<SyncResult> => {
        try {
          return await this.deps.engine.publish(dir);
        } catch {
          return "no-change";
        }
      }),
    );
    const status = worstStatus(results);
    this.setStatus(status);

    // Offline roots keep their checkpoints locally; retry on a delay.
    const queued = roots.filter((_, i) => results[i] === "queued");
    if (this.backoffTimer !== null) this.deps.clock.clearTimer(this.backoffTimer);
    this.backoffTimer = null;
    if (queued.length > 0) {
      this.backoffTimer = this.deps.clock.setTimer(() => {
        this.backoffTimer = null;
        void this.publishAll();
      }, BACKOFF_MS);
    }
    return status;
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
