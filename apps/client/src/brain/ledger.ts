// The company activity ledger - the record invariant 5 promises: every gated moment (an approval,
// a denial, a TTL auto-deny) becomes one readable line in activity/YYYY-MM.md in the TEAM brain.
// Sparse by design: wide autonomy makes gated moments rare, so a month is dozens of lines a human
// can actually read - never a log of routine autonomous work (file history already covers documents;
// this covers the moments a human was, or should have been, in the loop).
//
// Append-only markdown, one file per month, newest at the end - an entry is never rewritten, so the
// file reads like history, not state. The line derives ONLY from the resolved card + decision, with
// the clock injected (invariant 9: deterministic, zero LLM) and the phrasing shared with the Pending
// tray (gate/describe.ts) so the ledger says exactly what the card said. Living in the team repo, it
// syncs like any other brain file - no special handling anywhere downstream.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { describeAction } from "../gate/describe.js";
import type { LedgerResolution } from "../gate/approval.js";

export interface ActivityLedgerDeps {
  /** The team repo dir the `activity/` folder lives in. */
  dir: string;
  /** Injected clock - the entry's timestamp and its month file both derive from this. */
  now: () => number;
  /** Fs seams (hermetic tests). The default append creates the parent dir; the default read
   *  returns undefined for a month that has no file yet. */
  appendFile?: (path: string, text: string) => void;
  readFile?: (path: string) => string | undefined;
}

export class ActivityLedger {
  constructor(private readonly deps: ActivityLedgerDeps) {}

  /** Append one entry for a resolved card. Same inputs at the same instant → the same line. */
  record(res: LedgerResolution): void {
    const at = this.deps.now();
    const line = `- ${stamp(at)} · ${outcome(res)} · ${describeAction(res.tool)}${res.origin ? ` (${res.origin.kind})` : ""}\n`;
    const append = this.deps.appendFile ?? nodeAppend;
    append(join(this.deps.dir, "activity", `${monthOf(at)}.md`), line);
  }

  /** The current + previous month's entries (months with no file are skipped), current month first -
   *  what GET /api/ledger returns. Entries come back in file order (oldest first). */
  recent(): { month: string; entries: string[] }[] {
    const read = this.deps.readFile ?? nodeRead;
    const cur = monthOf(this.deps.now());
    const out: { month: string; entries: string[] }[] = [];
    for (const month of [cur, monthBefore(cur)]) {
      const raw = read(join(this.deps.dir, "activity", `${month}.md`));
      if (raw === undefined) continue;
      out.push({ month, entries: raw.split("\n").filter((l) => l.startsWith("- ")) });
    }
    return out;
  }
}

/** "approved by operator" / "denied by operator" / "auto-denied (timed out)" - who was in the loop. */
function outcome(res: LedgerResolution): string {
  if (res.verdict === "approve") return "approved by operator";
  return res.reason === "timeout" ? "auto-denied (timed out)" : "denied by operator";
}

/** "YYYY-MM-DD HH:MM", UTC - the same instant renders the same line on every machine that syncs
 *  the file (a local-time stamp would make two machines disagree about a shared repo's history). */
function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** The month file an instant belongs to ("YYYY-MM", UTC - same basis as the stamp). */
function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** "2026-07" → "2026-06" (and "2026-01" → "2025-12"). */
function monthBefore(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function nodeAppend(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text);
}

function nodeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
