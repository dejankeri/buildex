// The run ledger: a short ring per loop for the history strip. What is pinned here is that the ring
// stays bounded however long a loop runs, that each loop's history is its own, and that a corrupt
// file costs a forgotten history rather than a crash.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopRunsFile, RUNS_KEPT } from "./loops-runs.js";

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

describe("LoopRunsFile", () => {
  it("returns nothing for a loop that has never run", () => {
    expect(runs.history("sweep")).toEqual([]);
  });

  it("returns runs newest first", () => {
    runs.record("sweep", { at: T0, status: "ok" });
    runs.record("sweep", { at: T0 + 1000, status: "failed" });
    expect(runs.history("sweep").map((r) => r.status)).toEqual(["failed", "ok"]);
  });

  it("keeps a run's session so a row can open its transcript", () => {
    runs.record("sweep", { at: T0, status: "ok", sessionId: "s1" });
    expect(runs.history("sweep")[0]).toEqual({ at: T0, status: "ok", sessionId: "s1" });
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

  it("ignores keys it does not recognise, so an older file is read rather than refused", () => {
    writeFileSync(file, JSON.stringify({ version: 1, runs: { sweep: [{ at: T0, status: "ok" }] }, spend: { "2026-07-23": {} }, capUsd: 5 }));
    expect(runs.history("sweep")).toHaveLength(1);
  });

  it("forgets the history of a loop that no longer exists", () => {
    runs.record("sweep", { at: T0, status: "ok" });
    runs.record("gone", { at: T0, status: "ok" });
    runs.prune(new Set(["sweep"]));
    expect(Object.keys(runs.all())).toEqual(["sweep"]);
  });
});
