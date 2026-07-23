// The run ledger: a short ring per loop for the history strip, day buckets for the spending limit.
// What is pinned here is that the two never disagree about the same run, that the ring stays bounded
// however long a loop runs, and that deleting a loop cannot buy back today's budget.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopRunsFile, RUNS_KEPT, localDay, localMonthStart } from "./loops-runs.js";

let dir: string;
let file: string;
let runs: LoopRunsFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loops-runs-"));
  file = join(dir, ".loops-runs.json");
  runs = new LoopRunsFile(file);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = new Date(2026, 6, 23, 9, 0, 0).getTime(); // a Thursday, 9am local
const DAY = 86_400_000;

describe("localDay", () => {
  it("is the LOCAL calendar day, so the limit resets at the operator's midnight", () => {
    expect(localDay(new Date(2026, 6, 23, 23, 59, 0).getTime())).toBe("2026-07-23");
    expect(localDay(new Date(2026, 6, 24, 0, 1, 0).getTime())).toBe("2026-07-24");
  });

  it("day strings sort as text, which is what the range queries rely on", () => {
    expect(localDay(T0) > localMonthStart(T0)).toBe(true);
    expect(localMonthStart(T0)).toBe("2026-07-01");
  });
});

describe("LoopRunsFile — history", () => {
  it("returns nothing for a loop that has never run", () => {
    expect(runs.history("sweep")).toEqual([]);
  });

  it("returns runs newest first", () => {
    runs.record("sweep", { at: T0, status: "ok" });
    runs.record("sweep", { at: T0 + 1000, status: "failed" });
    expect(runs.history("sweep").map((r) => r.status)).toEqual(["failed", "ok"]);
  });

  it("keeps a run's session and cost so a row can open its transcript", () => {
    runs.record("sweep", { at: T0, status: "ok", sessionId: "s1", ms: 4200, costUsd: 0.041 });
    expect(runs.history("sweep")[0]).toEqual({ at: T0, status: "ok", sessionId: "s1", ms: 4200, costUsd: 0.041 });
  });

  it("keeps what a blocked run wanted to do", () => {
    runs.record("sweep", { at: T0, status: "needs-approval", blockedOn: "send an email to ops@acme.com" });
    expect(runs.history("sweep")[0]!.blockedOn).toBe("send an email to ops@acme.com");
  });

  it("holds the ring at RUNS_KEPT, dropping the oldest", () => {
    for (let i = 0; i < RUNS_KEPT + 12; i++) runs.record("sweep", { at: T0 + i * 1000, status: "ok" });
    const h = runs.history("sweep");
    expect(h).toHaveLength(RUNS_KEPT);
    expect(h[0]!.at).toBe(T0 + (RUNS_KEPT + 11) * 1000); // newest survives
    expect(h[RUNS_KEPT - 1]!.at).toBe(T0 + 12 * 1000); // the first twelve are gone
  });

  it("keeps each loop's ring separate", () => {
    runs.record("sweep", { at: T0, status: "ok" });
    runs.record("review", { at: T0, status: "failed" });
    expect(runs.all()["sweep"]!.map((r) => r.status)).toEqual(["ok"]);
    expect(runs.all()["review"]!.map((r) => r.status)).toEqual(["failed"]);
  });

  it("survives a corrupt file rather than throwing", () => {
    writeFileSync(file, "{not json");
    expect(runs.history("sweep")).toEqual([]);
    runs.record("sweep", { at: T0, status: "ok" });
    expect(runs.history("sweep")).toHaveLength(1);
  });
});

describe("LoopRunsFile — spend", () => {
  it("counts runs and money into the run's own local day", () => {
    runs.record("sweep", { at: T0, status: "ok", costUsd: 0.02 });
    runs.record("sweep", { at: T0 + 3600_000, status: "ok", costUsd: 0.03 });
    runs.record("sweep", { at: T0 + DAY, status: "ok", costUsd: 0.5 });
    const day = localDay(T0);
    expect(runs.spent(day, day)).toEqual({ runs: 2, costUsd: 0.05 });
  });

  it("sums a range of days", () => {
    runs.record("sweep", { at: T0, status: "ok", costUsd: 0.1 });
    runs.record("sweep", { at: T0 + DAY, status: "ok", costUsd: 0.2 });
    expect(runs.spent(localDay(T0), localDay(T0 + DAY))).toEqual({ runs: 2, costUsd: 0.3 });
  });

  it("counts a run the agent priced at nothing, so the run count stays honest", () => {
    runs.record("sweep", { at: T0, status: "ok" });
    const day = localDay(T0);
    expect(runs.spent(day, day)).toEqual({ runs: 1, costUsd: 0 });
  });

  it("does not drift into float noise as fractions of a cent accumulate", () => {
    for (let i = 0; i < 3; i++) runs.record("sweep", { at: T0, status: "ok", costUsd: 0.1 });
    const day = localDay(T0);
    expect(runs.spent(day, day).costUsd).toBe(0.3);
  });

  it("summarises today and the month against the ceiling", () => {
    runs.setCap(1);
    runs.record("sweep", { at: T0 - 5 * DAY, status: "ok", costUsd: 0.4 }); // earlier this month
    runs.record("sweep", { at: T0, status: "ok", costUsd: 0.25 });
    const s = runs.summary(T0);
    expect(s.today).toEqual({ runs: 1, costUsd: 0.25 });
    expect(s.month).toEqual({ runs: 2, costUsd: 0.65 });
    expect(s.capUsd).toBe(1);
    expect(s.overCap).toBe(false);
  });
});

describe("LoopRunsFile — the daily ceiling", () => {
  it("has none by default, so nothing is ever silently held back", () => {
    expect(runs.cap()).toBeUndefined();
    expect(runs.overCap(T0)).toBe(false);
  });

  it("is over once today's spend reaches it", () => {
    runs.setCap(0.5);
    runs.record("sweep", { at: T0, status: "ok", costUsd: 0.49 });
    expect(runs.overCap(T0)).toBe(false);
    runs.record("sweep", { at: T0, status: "ok", costUsd: 0.01 });
    expect(runs.overCap(T0)).toBe(true);
  });

  it("resets at the operator's midnight", () => {
    runs.setCap(0.5);
    runs.record("sweep", { at: T0, status: "ok", costUsd: 2 });
    expect(runs.overCap(T0)).toBe(true);
    expect(runs.overCap(T0 + DAY)).toBe(false);
  });

  it("clears on a zero or negative ceiling rather than pausing loops forever", () => {
    runs.setCap(1);
    runs.setCap(0);
    expect(runs.cap()).toBeUndefined();
    runs.setCap(1);
    runs.setCap(undefined);
    expect(runs.cap()).toBeUndefined();
  });
});

describe("LoopRunsFile — pruning", () => {
  it("forgets the history of a loop that no longer exists", () => {
    runs.record("sweep", { at: T0, status: "ok" });
    runs.record("gone", { at: T0, status: "ok" });
    runs.prune(new Set(["sweep"]), T0);
    expect(Object.keys(runs.all())).toEqual(["sweep"]);
  });

  it("still counts a deleted loop's spend today - deleting a loop must not buy back budget", () => {
    runs.setCap(0.5);
    runs.record("gone", { at: T0, status: "ok", costUsd: 0.9 });
    runs.prune(new Set([]), T0);
    expect(runs.overCap(T0)).toBe(true);
  });

  it("drops ledger days that have aged out of the window", () => {
    runs.record("sweep", { at: T0 - 200 * DAY, status: "ok", costUsd: 5 });
    runs.record("sweep", { at: T0, status: "ok", costUsd: 1 });
    runs.prune(new Set(["sweep"]), T0);
    expect(runs.spent("0000-00-00", "9999-99-99").costUsd).toBe(1);
  });
});
