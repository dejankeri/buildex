import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore, CADENCE_MS } from "./schedule-store.js";
import { tickOnce, type DefReader } from "./tick.js";

function fixture(startMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "tick-"));
  let now = startMs;
  let n = 0;
  const store = new ScheduleStore(join(dir, "control.db"), () => now, () => `run_${++n}`);
  return { store, advance: (ms: number) => (now += ms) };
}

const YAML = "- name: digest\n  verb: daily-digest\n  cadence: daily\n  enabled: true\n  catchUp: coalesce\n";

describe("tickOnce", () => {
  it("reconciles defs and creates a due run once the schedule is due", () => {
    const { store, advance } = fixture(0);
    const readDefs: DefReader = () => YAML;
    // First tick registers the schedule (next_fire = now → immediately due) and creates a run.
    const r1 = tickOnce({ store, readDefs, companies: () => ["co_1"] });
    expect(r1.created).toBe(1);
    // Second tick: one run still open → no new run.
    const r2 = tickOnce({ store, readDefs, companies: () => ["co_1"] });
    expect(r2.created).toBe(0);
    // Finish it, advance a day, tick again → a fresh run.
    const due = store.listRuns("co_1", "due")[0]!;
    store.claim("co_1", due.id, "m", 600_000);
    store.report("co_1", due.id, { state: "done" });
    advance(CADENCE_MS.daily + 1);
    expect(tickOnce({ store, readDefs, companies: () => ["co_1"] }).created).toBe(1);
  });

  it("a company with no automations.yaml (reader → null) is a no-op", () => {
    const { store } = fixture(0);
    const readDefs: DefReader = () => null;
    expect(tickOnce({ store, readDefs, companies: () => ["co_1"] })).toEqual({ created: 0, requeued: 0, failed: 0 });
  });
});

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { gitDefReader } from "./tick.js";

describe("gitDefReader", () => {
  it("reads automations.yaml from a bare repo's HEAD, null when absent", () => {
    const root = mkdtempSync(join(tmpdir(), "repos-"));
    const work = mkdtempSync(join(tmpdir(), "work-"));
    const bare = join(root, "team-co1.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });
    // seed a commit with automations.yaml through a working clone
    execFileSync("git", ["clone", bare, join(work, "c")], { stdio: "ignore" });
    const wc = join(work, "c");
    writeFileSync(join(wc, "automations.yaml"), YAML);
    for (const args of [
      ["-C", wc, "add", "automations.yaml"],
      ["-C", wc, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed"],
      ["-C", wc, "push", "origin", "HEAD:main"],
    ]) execFileSync("git", args, { stdio: "ignore" });

    const reader = gitDefReader(root, (id) => (id === "co_1" ? "team-co1" : "nope"));
    expect(reader("co_1")).toContain("daily-digest");
    expect(reader("co_2")).toBeNull(); // no such repo
  });
});
