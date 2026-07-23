// What each loop actually did, and what it cost. Local, uncommitted, and deliberately two shapes in
// one file because they answer two different questions from the same event:
//
//   * `runs`  - a short ring per loop (the last RUNS_KEPT), so "it fails every Monday" is visible
//               instead of hidden behind a single last-run chip.
//   * `spend` - per local DAY totals, so a ceiling can be enforced and a month can be summed without
//               keeping ten thousand rows for a loop that runs every five minutes.
//
// The day, not a rolling window, is the unit on purpose: "loops may spend $5 a day, and the clock
// resets at midnight" is a sentence a non-technical operator can hold in their head and predict. A
// rolling 24 hours is more accurate and less legible, and legibility is what makes a spending limit
// something an operator will actually set.
//
// Never committed (invariant 2 keeps the BRAIN in git; this is machine bookkeeping, and one machine's
// spend is not another's). A corrupt file costs at most a forgotten history, never a crash.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** One finished run, as the history strip and the run list render it. */
export interface LoopRun {
  at: number;
  status: "ok" | "failed" | "needs-approval" | "missed";
  /** The session this run produced, so a history row can open its transcript. Absent for `missed`. */
  sessionId?: string;
  /** Wall-clock duration of the run. */
  ms?: number;
  /** What the run cost, as the agent reported it. Absent when the agent did not say. */
  costUsd?: number;
  /** What it needed a human for, when it ended `needs-approval`. */
  blockedOn?: string;
}

export interface SpendTotals {
  runs: number;
  costUsd: number;
}

/** Runs kept per loop. Twenty is about a month of a daily loop - enough to see a pattern, small
 *  enough that the whole history ships inside the ordinary /api/loops response. */
export const RUNS_KEPT = 20;

/** How far back the spend ledger reaches. Two months covers "this month" plus the previous one. */
const DAYS_KEPT = 62;

interface RunsDoc {
  version: 1;
  /** loop name → runs, oldest first. */
  runs: Record<string, LoopRun[]>;
  /** local day → loop name → totals. Kept even for deleted loops: the money was still spent. */
  spend: Record<string, Record<string, SpendTotals>>;
  /** The ceiling for unattended spend per local day, in USD. Absent means no ceiling. */
  capUsd?: number;
}

/** The local calendar day containing `ms`, as `YYYY-MM-DD`. Local, not UTC: the operator's midnight
 *  is when they expect the limit to reset, and ISO day strings sort and compare as plain text. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The first day of the local month containing `ms`, as `YYYY-MM-DD`. */
export function localMonthStart(ms: number): string {
  return localDay(ms).slice(0, 8) + "01";
}

/** What the panel shows above the list: today against its ceiling, and the month so far. */
export interface SpendSummary {
  today: SpendTotals;
  month: SpendTotals;
  capUsd?: number;
  /** True when today's spend has reached the ceiling, so the scheduler is holding off. */
  overCap: boolean;
}

export class LoopRunsFile {
  constructor(private readonly file: string) {}

  private read(): RunsDoc {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!parsed || typeof parsed !== "object") return empty();
      const doc = parsed as Partial<RunsDoc>;
      return {
        version: 1,
        runs: doc.runs && typeof doc.runs === "object" ? doc.runs : {},
        spend: doc.spend && typeof doc.spend === "object" ? doc.spend : {},
        ...(typeof doc.capUsd === "number" ? { capUsd: doc.capUsd } : {}),
      };
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

  /** Append a run: onto the loop's ring, and onto the day's ledger. */
  record(name: string, run: LoopRun): void {
    const doc = this.read();
    const list = doc.runs[name] ?? [];
    list.push(run);
    doc.runs[name] = list.slice(-RUNS_KEPT);

    const day = localDay(run.at);
    const byLoop = (doc.spend[day] ??= {});
    const totals = (byLoop[name] ??= { runs: 0, costUsd: 0 });
    totals.runs += 1;
    // Round as we accumulate: JSON is the storage, and un-rounded float addition would drift into
    // 0.30000000000000004 in a number the operator reads as money.
    totals.costUsd = round(totals.costUsd + (run.costUsd ?? 0));

    this.write(dropOldDays(doc, run.at));
  }

  /** Totals over a closed range of local days (inclusive), across every loop. */
  spent(fromDay: string, toDay: string): SpendTotals {
    const out: SpendTotals = { runs: 0, costUsd: 0 };
    for (const [day, byLoop] of Object.entries(this.read().spend)) {
      if (day < fromDay || day > toDay) continue;
      for (const t of Object.values(byLoop)) {
        out.runs += t.runs;
        out.costUsd += t.costUsd;
      }
    }
    out.costUsd = round(out.costUsd);
    return out;
  }

  /** The ceiling on unattended spend per local day, in USD; undefined when there is none. */
  cap(): number | undefined {
    return this.read().capUsd;
  }

  /** Set (or, with undefined/0/negative, clear) the daily ceiling. */
  setCap(usd: number | undefined): void {
    const doc = this.read();
    if (usd === undefined || !Number.isFinite(usd) || usd <= 0) delete doc.capUsd;
    else doc.capUsd = round(usd);
    this.write(doc);
  }

  /** Today against its ceiling, and the month so far. */
  summary(now: number): SpendSummary {
    const day = localDay(now);
    const today = this.spent(day, day);
    const capUsd = this.cap();
    return {
      today,
      month: this.spent(localMonthStart(now), day),
      ...(capUsd !== undefined ? { capUsd } : {}),
      overCap: capUsd !== undefined && today.costUsd >= capUsd,
    };
  }

  /** True when today's unattended spend has reached the ceiling. */
  overCap(now: number): boolean {
    const capUsd = this.cap();
    if (capUsd === undefined) return false;
    const day = localDay(now);
    return this.spent(day, day).costUsd >= capUsd;
  }

  /** Forget the run history of loops that no longer exist, and days that have aged out. The SPEND
   *  ledger keeps deleted loops within its window - deleting a loop does not un-spend its money, and
   *  letting it reset today's ceiling would make the limit trivially escapable. */
  prune(keep: Set<string>, now: number): void {
    const doc = this.read();
    let changed = false;
    for (const name of Object.keys(doc.runs)) {
      if (!keep.has(name)) {
        delete doc.runs[name];
        changed = true;
      }
    }
    const before = Object.keys(doc.spend).length;
    const trimmed = dropOldDays(doc, now);
    if (changed || Object.keys(trimmed.spend).length !== before) this.write(trimmed);
  }

  private write(doc: RunsDoc): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(doc, null, 2) + "\n");
  }
}

function empty(): RunsDoc {
  return { version: 1, runs: {}, spend: {} };
}

/** Drop ledger days older than the window, measured back from `now`. */
function dropOldDays(doc: RunsDoc, now: number): RunsDoc {
  const cutoff = localDay(now - DAYS_KEPT * 86_400_000);
  for (const day of Object.keys(doc.spend)) if (day < cutoff) delete doc.spend[day];
  return doc;
}

/** Money, to the cent-hundredth. Loop runs are routinely fractions of a cent, so four places. */
function round(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}
