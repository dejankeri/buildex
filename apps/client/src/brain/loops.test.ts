// loops.yaml is the committed definition of every scheduled run (invariant 2), so the reader has to
// be tolerant of hand-editing and the writer has to round-trip what it read. Run state is
// deliberately NOT here - it lives in an uncommitted state file so scheduling churn never touches
// the brain.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLoopsYaml,
  serializeLoopsYaml,
  LoopDefStore,
  LoopStateFile,
  migrateAutomationsYaml,
  type LoopDef,
} from "./loops.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loops-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SAMPLE = `# the company's loops
- name: monday-review
  title: Weekly review
  prompt: Read last week's activity log and draft the Monday update
  at: "09:00"
  days: mon
  enabled: true

- name: inbox-sweep
  title: Inbox sweep
  verb: triage-inbox
  every: 2h
  enabled: false
`;

describe("parseLoopsYaml", () => {
  it("reads a prompt loop and a verb loop", () => {
    const loops = parseLoopsYaml(SAMPLE);
    expect(loops).toHaveLength(2);
    expect(loops[0]).toEqual({
      name: "monday-review",
      title: "Weekly review",
      prompt: "Read last week's activity log and draft the Monday update",
      schedule: { kind: "at", hour: 9, minute: 0, days: ["mon"] },
      enabled: true,
    });
    expect(loops[1]).toEqual({
      name: "inbox-sweep",
      title: "Inbox sweep",
      verb: "triage-inbox",
      schedule: { kind: "every", ms: 7_200_000, raw: "2h" },
      enabled: false,
    });
  });

  it("defaults the title to the name and enabled to true", () => {
    const [loop] = parseLoopsYaml("- name: nightly\n  prompt: tidy up\n  every: 1d\n");
    expect(loop!.title).toBe("nightly");
    expect(loop!.enabled).toBe(true);
  });

  it("treats an empty day list as every day", () => {
    const [loop] = parseLoopsYaml('- name: standup\n  prompt: draft it\n  at: "09:00"\n');
    expect(loop!.schedule).toEqual({ kind: "at", hour: 9, minute: 0, days: [] });
  });

  it("reads a day list in any case or spacing, in week order", () => {
    const [loop] = parseLoopsYaml('- name: s\n  prompt: p\n  at: "09:00"\n  days: Fri, mon,WED\n');
    expect(loop!.schedule).toEqual({ kind: "at", hour: 9, minute: 0, days: ["mon", "wed", "fri"] });
  });

  it("skips items it cannot honour rather than guessing at them", () => {
    const bad = [
      "- name: Both\n  prompt: p\n  verb: v\n  every: 1h\n", // prompt AND verb
      "- name: neither\n  every: 1h\n", // no body
      "- name: nosched\n  prompt: p\n", // no schedule
      "- name: twosched\n  prompt: p\n  every: 1h\n  at: \"09:00\"\n", // both schedules
      "- name: Upper\n  prompt: p\n  every: 1h\n", // not kebab-case
      "- name: toofast\n  prompt: p\n  every: 1m\n", // under the floor
      '- name: badtime\n  prompt: p\n  at: "25:00"\n',
      '- name: badtime2\n  prompt: p\n  at: "9am"\n',
    ].join("\n");
    expect(parseLoopsYaml(bad)).toEqual([]);
  });

  it("keeps the good items when one item in the file is broken", () => {
    const mixed = '- name: good\n  prompt: p\n  every: 1h\n\n- name: bad\n  prompt: p\n  at: "nope"\n';
    expect(parseLoopsYaml(mixed).map((l) => l.name)).toEqual(["good"]);
  });

  it("survives an empty or garbage file", () => {
    expect(parseLoopsYaml("")).toEqual([]);
    expect(parseLoopsYaml("just some prose\nnot a list at all\n")).toEqual([]);
  });
});

describe("serializeLoopsYaml", () => {
  it("round-trips what it parsed", () => {
    const loops = parseLoopsYaml(SAMPLE);
    expect(parseLoopsYaml(serializeLoopsYaml(loops))).toEqual(loops);
  });

  it("quotes a time so YAML cannot read it as a sexagesimal number", () => {
    const out = serializeLoopsYaml(parseLoopsYaml(SAMPLE));
    expect(out).toContain('at: "09:00"');
  });

  it("writes a prompt containing a colon so it still round-trips", () => {
    const loop: LoopDef = {
      name: "tricky",
      title: "Tricky",
      prompt: "Draft the update: lead with revenue",
      schedule: { kind: "every", ms: 3_600_000, raw: "1h" },
      enabled: true,
    };
    expect(parseLoopsYaml(serializeLoopsYaml([loop]))).toEqual([loop]);
  });

  it("emits an empty string for no loops, not a stray marker", () => {
    expect(serializeLoopsYaml([])).toBe("");
  });
});

describe("LoopDefStore", () => {
  const file = () => join(dir, "loops.yaml");

  it("returns nothing when the file does not exist", () => {
    expect(new LoopDefStore(file()).list()).toEqual([]);
  });

  it("adds, updates, toggles and removes", () => {
    const store = new LoopDefStore(file());
    const added = store.add({ title: "Weekly review", prompt: "draft it", schedule: { kind: "every", ms: 3_600_000, raw: "1h" } });
    expect(added.name).toBe("weekly-review");
    expect(store.list()).toHaveLength(1);

    store.update("weekly-review", { enabled: false });
    expect(store.list()[0]!.enabled).toBe(false);

    store.remove("weekly-review");
    expect(store.list()).toEqual([]);
  });

  it("derives a kebab-case name from the title and keeps it unique", () => {
    const store = new LoopDefStore(file());
    expect(store.add({ title: "Weekly Review!", prompt: "p", schedule: { kind: "every", ms: 3_600_000, raw: "1h" } }).name).toBe(
      "weekly-review",
    );
    expect(store.add({ title: "Weekly review", prompt: "p", schedule: { kind: "every", ms: 3_600_000, raw: "1h" } }).name).toBe(
      "weekly-review-2",
    );
  });

  it("refuses a loop with neither a prompt nor a verb", () => {
    const store = new LoopDefStore(file());
    expect(() => store.add({ title: "Empty", schedule: { kind: "every", ms: 3_600_000, raw: "1h" } })).toThrow(/prompt or a verb/i);
  });

  it("refuses to update a loop that is not there", () => {
    expect(() => new LoopDefStore(file()).update("ghost", { enabled: false })).toThrow(/not found/i);
  });

  it("preserves the other loops when one is updated", () => {
    const store = new LoopDefStore(file());
    store.add({ title: "One", prompt: "a", schedule: { kind: "every", ms: 3_600_000, raw: "1h" } });
    store.add({ title: "Two", prompt: "b", schedule: { kind: "at", hour: 9, minute: 0, days: [] } });
    store.update("one", { title: "One renamed" });
    expect(store.list().map((l) => [l.name, l.title])).toEqual([
      ["one", "One renamed"],
      ["two", "Two"],
    ]);
  });
});

describe("LoopStateFile", () => {
  it("starts empty and remembers what it is told", () => {
    const state = new LoopStateFile(join(dir, "state.json"));
    expect(state.get("weekly")).toBeUndefined();

    state.set("weekly", { firstSeen: 1000 });
    state.set("weekly", { lastRun: 2000, status: "ok", sessionId: "s1" });
    expect(state.get("weekly")).toEqual({ firstSeen: 1000, lastRun: 2000, status: "ok", sessionId: "s1" });
  });

  it("clears a field when it is set to undefined - a fresh run drops the old blocker", () => {
    const state = new LoopStateFile(join(dir, "state.json"));
    state.set("weekly", { status: "needs-approval", blockedOn: "send an email" });
    state.set("weekly", { status: "ok", blockedOn: undefined });
    expect(state.get("weekly")).toEqual({ status: "ok" });
  });

  it("treats a corrupt state file as no state rather than throwing", () => {
    const file = join(dir, "state.json");
    writeFileSync(file, "{ this is not json");
    const state = new LoopStateFile(file);
    expect(state.get("weekly")).toBeUndefined();
    state.set("weekly", { firstSeen: 1 });
    expect(state.get("weekly")).toEqual({ firstSeen: 1 });
  });

  it("drops state for loops that no longer exist", () => {
    const state = new LoopStateFile(join(dir, "state.json"));
    state.set("kept", { firstSeen: 1 });
    state.set("gone", { firstSeen: 2 });
    state.prune(new Set(["kept"]));
    expect(state.get("kept")).toEqual({ firstSeen: 1 });
    expect(state.get("gone")).toBeUndefined();
  });
});

describe("migrateAutomationsYaml", () => {
  it("lifts hourly/daily/weekly automations into loops and leaves the old file alone", () => {
    const legacy = join(dir, "automations.yaml");
    const loops = join(dir, "loops.yaml");
    writeFileSync(
      legacy,
      "- name: weekly-review\n  verb: weekly-review\n  cadence: weekly\n  enabled: true\n  catchUp: coalesce\n" +
        "- name: hourly-sweep\n  verb: sweep\n  cadence: hourly\n  enabled: false\n",
    );

    expect(migrateAutomationsYaml(legacy, loops)).toBe(true);
    expect(parseLoopsYaml(readFileSync(loops, "utf8"))).toEqual([
      { name: "weekly-review", title: "weekly-review", verb: "weekly-review", schedule: { kind: "every", ms: 604_800_000, raw: "7d" }, enabled: true },
      { name: "hourly-sweep", title: "hourly-sweep", verb: "sweep", schedule: { kind: "every", ms: 3_600_000, raw: "1h" }, enabled: false },
    ]);
    expect(existsSync(legacy)).toBe(true); // invariant 8 - never destroy the operator's file
  });

  it("does nothing when loops.yaml already exists", () => {
    const legacy = join(dir, "automations.yaml");
    const loops = join(dir, "loops.yaml");
    writeFileSync(legacy, "- name: a\n  verb: v\n  cadence: daily\n");
    writeFileSync(loops, "- name: mine\n  prompt: p\n  every: 1h\n");

    expect(migrateAutomationsYaml(legacy, loops)).toBe(false);
    expect(parseLoopsYaml(readFileSync(loops, "utf8")).map((l) => l.name)).toEqual(["mine"]);
  });

  it("does nothing when there is no legacy file", () => {
    expect(migrateAutomationsYaml(join(dir, "nope.yaml"), join(dir, "loops.yaml"))).toBe(false);
    expect(existsSync(join(dir, "loops.yaml"))).toBe(false);
  });
});
