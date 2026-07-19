// The durable automation clock + queue. Definitions come from the git brain and are
// reconciled here; only churny run-state (next_fire_at, leases, the run ledger) lives in SQLite - it
// is never synced. This module is pure bookkeeping - it NEVER runs an agent (invariant 1).
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type Cadence = "hourly" | "daily" | "weekly";
export type CatchUp = "coalesce" | "each";
export type RunState = "due" | "claimed" | "done" | "failed";

export interface ScheduleDef {
  name: string;
  verb: string;
  cadence: Cadence;
  enabled: boolean;
  catchUp: CatchUp;
}

export interface RunRow {
  id: string;
  companyId: string;
  scheduleName: string;
  verb: string;
  dueAt: number;
  state: RunState;
  claimedBy: string | null;
  claimedAt: number | null;
  leaseExpiresAt: number | null;
  attempts: number;
  finishedAt: number | null;
  sessionId: string | null;
  error: string | null;
}

const HOUR = 3600_000;
export const CADENCE_MS: Record<Cadence, number> = { hourly: HOUR, daily: 24 * HOUR, weekly: 7 * 24 * HOUR };

function defaultId(): string {
  return `run_${randomUUID()}`;
}

export class ScheduleStore {
  private readonly db: DatabaseSync;
  constructor(
    dbPath: string,
    private readonly now: () => number = Date.now,
    private readonly genId: () => string = defaultId,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_schedules (
        company_id TEXT NOT NULL, name TEXT NOT NULL, verb TEXT NOT NULL, cadence TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, catch_up TEXT NOT NULL DEFAULT 'coalesce',
        next_fire_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (company_id, name)
      );
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, schedule_name TEXT NOT NULL, verb TEXT NOT NULL,
        due_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'due',
        claimed_by TEXT, claimed_at INTEGER, lease_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, finished_at INTEGER, session_id TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_company_state ON automation_runs (company_id, state);
    `);
  }

  reconcile(companyId: string, defs: ScheduleDef[]): void {
    const t = this.now();
    const names = new Set(defs.map((d) => d.name));
    // upsert
    for (const d of defs) {
      const existing = this.db
        .prepare("SELECT next_fire_at FROM automation_schedules WHERE company_id = ? AND name = ?")
        .get(companyId, d.name) as { next_fire_at: number } | undefined;
      if (existing) {
        this.db
          .prepare(
            "UPDATE automation_schedules SET verb=?, cadence=?, enabled=?, catch_up=?, updated_at=? WHERE company_id=? AND name=?",
          )
          .run(d.verb, d.cadence, d.enabled ? 1 : 0, d.catchUp, t, companyId, d.name);
      } else {
        this.db
          .prepare(
            "INSERT INTO automation_schedules (company_id, name, verb, cadence, enabled, catch_up, next_fire_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(companyId, d.name, d.verb, d.cadence, d.enabled ? 1 : 0, d.catchUp, t, t);
      }
    }
    // prune (schedules + their runs)
    const rows = this.db
      .prepare("SELECT name FROM automation_schedules WHERE company_id = ?")
      .all(companyId) as { name: string }[];
    for (const r of rows) {
      if (!names.has(r.name)) {
        this.db.prepare("DELETE FROM automation_schedules WHERE company_id=? AND name=?").run(companyId, r.name);
        this.db.prepare("DELETE FROM automation_runs WHERE company_id=? AND schedule_name=?").run(companyId, r.name);
      }
    }
    // A schedule the operator just disabled shouldn't leave a queued run behind for a machine to
    // pick up later - cancel anything still 'due'. Leave 'claimed' runs alone: they're in-flight
    // and disabling must not orphan or interrupt work already underway.
    for (const d of defs) {
      if (d.enabled) continue;
      this.db.prepare("DELETE FROM automation_runs WHERE company_id=? AND schedule_name=? AND state='due'").run(companyId, d.name);
    }
  }

  createDueRuns(companyId: string, opts?: { backlogCap?: number }): RunRow[] {
    const cap = opts?.backlogCap ?? 24;
    const t = this.now();
    const created: RunRow[] = [];
    const scheds = this.db
      .prepare("SELECT * FROM automation_schedules WHERE company_id = ? AND enabled = 1")
      .all(companyId) as Record<string, unknown>[];
    for (const s of scheds) {
      const name = s["name"] as string;
      const verb = s["verb"] as string;
      const cadence = s["cadence"] as Cadence;
      const catchUp = s["catch_up"] as CatchUp;
      let nextFire = s["next_fire_at"] as number;
      const step = CADENCE_MS[cadence];
      if (t < nextFire) continue;

      if (catchUp === "coalesce") {
        if (this.hasOpenRun(companyId, name)) continue;
        created.push(this.insertRun(companyId, name, verb, nextFire));
        // advance to the next slot strictly after now
        while (nextFire <= t) nextFire += step;
      } else {
        // each: one run per missed slot, bounded
        let open = this.countOpenRuns(companyId, name);
        while (nextFire <= t && open < cap) {
          created.push(this.insertRun(companyId, name, verb, nextFire));
          nextFire += step;
          open += 1;
        }
        // if capped, still advance next_fire past now so we don't spin
        while (nextFire <= t) nextFire += step;
      }
      this.db.prepare("UPDATE automation_schedules SET next_fire_at=? WHERE company_id=? AND name=?").run(nextFire, companyId, name);
    }
    return created;
  }

  listRuns(companyId: string, state?: RunState): RunRow[] {
    const rows = state
      ? (this.db.prepare("SELECT * FROM automation_runs WHERE company_id=? AND state=? ORDER BY due_at ASC").all(companyId, state) as Record<string, unknown>[])
      : (this.db.prepare("SELECT * FROM automation_runs WHERE company_id=? ORDER BY due_at ASC").all(companyId) as Record<string, unknown>[]);
    return rows.map(rowToRun);
  }

  claim(companyId: string, id: string, machineId: string, leaseMs: number): RunRow | null {
    const t = this.now();
    const res = this.db
      .prepare(
        "UPDATE automation_runs SET state='claimed', claimed_by=?, claimed_at=?, lease_expires_at=? WHERE id=? AND company_id=? AND state='due'",
      )
      .run(machineId, t, t + leaseMs, id, companyId);
    if (res.changes !== 1) return null;
    return this.getRun(companyId, id);
  }

  report(companyId: string, id: string, r: { state: "done" | "failed"; sessionId?: string; error?: string }): RunRow | null {
    const t = this.now();
    // A long-running verb can outlive its lease and get reaped (claimed → due) mid-run; when it
    // finishes, its report must still land instead of being 409-rejected and the work silently
    // dropped - so accept a report against either state (never against 'done'/'failed' - no double-report).
    const res = this.db
      .prepare("UPDATE automation_runs SET state=?, finished_at=?, session_id=?, error=? WHERE id=? AND company_id=? AND state IN ('claimed','due')")
      .run(r.state, t, r.sessionId ?? null, r.error ?? null, id, companyId);
    if (res.changes !== 1) return null;
    return this.getRun(companyId, id);
  }

  heartbeat(companyId: string, id: string, machineId: string, leaseMs: number): RunRow | null {
    const t = this.now();
    const res = this.db
      .prepare("UPDATE automation_runs SET lease_expires_at=? WHERE id=? AND company_id=? AND state='claimed' AND claimed_by=?")
      .run(t + leaseMs, id, companyId, machineId);
    if (res.changes !== 1) return null;
    return this.getRun(companyId, id);
  }

  reap(companyId: string, opts?: { maxAttempts?: number }): { requeued: number; failed: number } {
    const t = this.now();
    const maxAttempts = opts?.maxAttempts ?? 3;
    const expired = this.db
      .prepare("SELECT id, attempts FROM automation_runs WHERE company_id=? AND state='claimed' AND lease_expires_at < ?")
      .all(companyId, t) as { id: string; attempts: number }[];
    let requeued = 0;
    let failed = 0;
    for (const e of expired) {
      const attempts = e.attempts + 1;
      if (attempts >= maxAttempts) {
        this.db.prepare("UPDATE automation_runs SET state='failed', attempts=?, error=?, finished_at=? WHERE id=? AND company_id=?").run(attempts, "lease expired (poison-pill)", t, e.id, companyId);
        failed += 1;
      } else {
        this.db.prepare("UPDATE automation_runs SET state='due', attempts=?, claimed_by=NULL, claimed_at=NULL, lease_expires_at=NULL WHERE id=? AND company_id=?").run(attempts, e.id, companyId);
        requeued += 1;
      }
    }
    return { requeued, failed };
  }

  nextFireAt(companyId: string, name: string): number | null {
    const row = this.db.prepare("SELECT next_fire_at FROM automation_schedules WHERE company_id=? AND name=?").get(companyId, name) as { next_fire_at: number } | undefined;
    return row ? row.next_fire_at : null;
  }

  getRun(companyId: string, id: string): RunRow | null {
    const row = this.db.prepare("SELECT * FROM automation_runs WHERE company_id=? AND id=?").get(companyId, id) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : null;
  }

  close(): void {
    this.db.close();
  }

  // --- internals ---
  private hasOpenRun(companyId: string, name: string): boolean {
    return this.countOpenRuns(companyId, name) > 0;
  }
  private countOpenRuns(companyId: string, name: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE company_id=? AND schedule_name=? AND state IN ('due','claimed')")
      .get(companyId, name) as { n: number };
    return row.n;
  }
  private insertRun(companyId: string, name: string, verb: string, dueAt: number): RunRow {
    const id = this.genId();
    this.db
      .prepare("INSERT INTO automation_runs (id, company_id, schedule_name, verb, due_at, state, attempts) VALUES (?,?,?,?,?,'due',0)")
      .run(id, companyId, name, verb, dueAt);
    return this.getRun(companyId, id)!;
  }
}

function rowToRun(r: Record<string, unknown>): RunRow {
  return {
    id: r["id"] as string,
    companyId: r["company_id"] as string,
    scheduleName: r["schedule_name"] as string,
    verb: r["verb"] as string,
    dueAt: r["due_at"] as number,
    state: r["state"] as RunState,
    claimedBy: (r["claimed_by"] as string | null) ?? null,
    claimedAt: (r["claimed_at"] as number | null) ?? null,
    leaseExpiresAt: (r["lease_expires_at"] as number | null) ?? null,
    attempts: r["attempts"] as number,
    finishedAt: (r["finished_at"] as number | null) ?? null,
    sessionId: (r["session_id"] as string | null) ?? null,
    error: (r["error"] as string | null) ?? null,
  };
}
