// Background sync loop.
// Owns *when* a sync runs; the SyncEngine primitive owns *how*. Debounces bursts of edits into a
// single checkpoint, runs a background receive tick, retries offline sends with bounded backoff.
// Deterministic: all timing goes through an injected clock so tests run on a fake clock with no
// real timers.
//
// Mutual exclusion is PER ROOT, not per operation: checkpoint, receive and publish all run through
// `exclusive(dir, ...)`, which chains them on one promise per repository. Two git operations in one
// worktree race on the index lock, and a rebase that fails because another operation held the lock
// would trip the engine's conflict path - a spurious "needs help" plus a hard reset. The
// `flushing`/`rerun` pair below is a separate, narrower guard: it only coalesces overlapping
// debounce flushes.
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
/** How many times an offline send is retried before it stops on its own. Retries double the wait
 *  (5s, 10s, 20s, 40s, 80s), so a laptop that is offline for an afternoon stops re-running git every
 *  five seconds - and stops flickering the dot between busy and queued. After the last attempt the
 *  status stays "queued": the work is safe locally and the operator can save again by hand. */
const MAX_RETRIES = 5;

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
  /** The per-root result of the last publish - lets the console say WHICH root is stuck, alongside
   *  the collapsed worst status. Populated in `publishRoots`; `perRoot()` hands out a copy. */
  private lastPerRoot: Record<string, SyncStatus> = {};
  /** One promise chain per repository - the per-root mutex (see the file comment). */
  private readonly chain = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SyncSchedulerDeps) {}

  /** Run `fn` with exclusive access to `dir`: it starts only once every operation already queued
   *  for that repository has settled. Failures never poison the chain for the next caller. */
  private exclusive<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chain.get(dir) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chain.set(
      dir,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

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
        // Checkpoint FIRST, always. Receiving rebases, and a rebase refuses to start on a dirty
        // tree - the engine then treats that as a conflict and resets to the remote, which would
        // destroy an edit that was never recorded (invariant 8). Checkpointing is network-free, so
        // this tick still sends nothing. Both halves run under one exclusive lease so a save
        // cannot interleave between them.
        const r = await this.exclusive(dir, async () => {
          await this.deps.engine.checkpoint(dir);
          return this.deps.engine.receive(dir);
        });
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
    // Defensive, not load-bearing: flush() has no network side effects any more (it only records
    // checkpoints locally), so it cannot arm the backoff timer itself. This second clear just
    // guards against a future flush() gaining a side effect without this invariant being revisited.
    this.clearAllTimers();
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
    if (s === this.lastStatus) return; // the dot is already here - don't repaint it for no change
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
            await this.exclusive(dir, () => this.deps.engine.checkpoint(dir));
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
    // Signal busy the INSTANT the operator clicks, before anything can block. The flush below, and
    // the publish after it, both take the per-root lease - so a background receive tick that is mid
    // network op can hold it and stall this call for seconds. Without this the dot would sit on its
    // old state through that whole wait and the click would look ignored. setStatus dedupes, so the
    // busy that publishRoots sets next is not a second repaint.
    this.setStatus("busy");
    await this.flush(); // record anything still in the debounce window first
    return this.publishRoots(this.deps.writableRoots(), 0);
  }

  /** Send exactly `roots`. The retry path re-enters here with the roots that were pending AT CLICK
   *  TIME and never re-flushes: an operator who saved while offline asked to send what existed then,
   *  not an hour of work they did afterwards. Sending more than they asked for would break the one
   *  rule this whole surface exists to keep. */
  private async publishRoots(roots: string[], attempt: number): Promise<SyncStatus> {
    this.setStatus("busy");
    const results = await Promise.all(
      roots.map((dir) =>
        this.exclusive(dir, async (): Promise<SyncResult> => {
          try {
            return await this.deps.engine.publish(dir);
          } catch {
            // A throw is a FAILURE to send (a cloud-synced workspace, a corrupt repository, a git
            // timeout). It must never be laundered into "no-change", which ranks as success and
            // would tell the operator their work went out when it never left.
            return "needs-help";
          }
        }),
      ),
    );
    const status = worstStatus(results);
    this.setStatus(status);
    // "no-change" is a SyncResult, not a SyncStatus - worstStatus() already treats it as "ok" (it
    // isn't needs-help/queued/local), so the per-root map collapses it the same way for consistency.
    for (let i = 0; i < roots.length; i++) {
      const r = results[i]!;
      this.lastPerRoot[roots[i]!] = r === "no-change" ? "ok" : r;
    }

    // Offline roots keep their checkpoints locally; retry those roots (only those) on a doubling
    // delay, a bounded number of times. When the retries run out the status stays "queued" - the
    // work is safe on disk and saving again is one tap away.
    const queued = roots.filter((_, i) => results[i] === "queued");
    if (this.backoffTimer !== null) this.deps.clock.clearTimer(this.backoffTimer);
    this.backoffTimer = null;
    if (queued.length > 0 && attempt < MAX_RETRIES) {
      this.backoffTimer = this.deps.clock.setTimer(
        () => {
          this.backoffTimer = null;
          void this.publishRoots(queued, attempt + 1);
        },
        BACKOFF_MS * 2 ** attempt,
      );
    }
    return status;
  }

  /** The per-root status of the last publish, keyed by dir - a copy, never the internal object. */
  perRoot(): Record<string, SyncStatus> {
    return { ...this.lastPerRoot };
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
