// What each loop actually did — a short ring of past runs per loop, so "it fails every Monday" is
// visible instead of hidden behind a single last-run chip.
//
// Local and never committed (invariant 2 keeps the BRAIN in git; this is machine bookkeeping, and
// one machine's runs are not another's). A corrupt file costs at most a forgotten history, never a
// crash — the same contract as the run stamps beside it.
//
// Deliberately records what HAPPENED and not what it consumed. An earlier cut of this file also kept
// per-day cost totals to enforce a spending ceiling; that was removed because the only per-run price
// an agent reports is a dollar figure, and on a fixed subscription no dollars change hands — the
// scarce thing is the usage window, which is account-level and cannot be attributed to one loop.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** One finished run, as the history strip and the run list render it. */
export interface LoopRun {
  at: number;
  status: "ok" | "failed" | "needs-approval" | "missed";
  /** The session this run produced, so a history row can open its transcript. Absent for `missed`. */
  sessionId?: string;
  /** What it needed a human for, when it ended `needs-approval`. */
  blockedOn?: string;
}

/** Runs kept per loop. Twenty is about a month of a daily loop - enough to see a pattern, small
 *  enough that the whole history ships inside the ordinary /api/loops response. */
export const RUNS_KEPT = 20;

interface RunsDoc {
  version: 1;
  /** loop name → runs, oldest first. */
  runs: Record<string, LoopRun[]>;
}

export class LoopRunsFile {
  constructor(private readonly file: string) {}

  private read(): RunsDoc {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!parsed || typeof parsed !== "object") return empty();
      const doc = parsed as Partial<RunsDoc>;
      return { version: 1, runs: doc.runs && typeof doc.runs === "object" ? doc.runs : {} };
    } catch {
      return empty();
    }
  }

  /** This loop's runs, newest first. */
  history(name: string): LoopRun[] {
    return [...(this.read().runs[name] ?? [])].reverse();
  }

  /** Every loop's runs, newest first. One read, for building a list response. */
  all(): Record<string, LoopRun[]> {
    const doc = this.read();
    const out: Record<string, LoopRun[]> = {};
    for (const [name, list] of Object.entries(doc.runs)) out[name] = [...list].reverse();
    return out;
  }

  /** Append a run onto the loop's ring, dropping the oldest once it is full. */
  record(name: string, run: LoopRun): void {
    const doc = this.read();
    const list = doc.runs[name] ?? [];
    list.push(run);
    doc.runs[name] = list.slice(-RUNS_KEPT);
    this.write(doc);
  }

  /** Forget the history of loops that no longer exist, so a deleted-and-recreated name starts clean. */
  prune(keep: Set<string>): void {
    const doc = this.read();
    let changed = false;
    for (const name of Object.keys(doc.runs)) {
      if (!keep.has(name)) {
        delete doc.runs[name];
        changed = true;
      }
    }
    if (changed) this.write(doc);
  }

  private write(doc: RunsDoc): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(doc, null, 2) + "\n");
  }
}

function empty(): RunsDoc {
  return { version: 1, runs: {} };
}
