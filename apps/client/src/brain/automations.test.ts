import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutomationStore,
  isDue,
  nextRunMs,
  cadenceMs,
  type Automation,
  parseAutomationsYaml,
  serializeAutomationsYaml,
  AutomationDefStore,
  migrateJsonToYaml,
  type AutomationDef,
  AutomationStateFile,
} from "./automations.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe("cadence → interval", () => {
  it("maps the three cadences", () => {
    expect(cadenceMs("hourly")).toBe(HOUR);
    expect(cadenceMs("daily")).toBe(DAY);
    expect(cadenceMs("weekly")).toBe(7 * DAY);
  });
});

describe("isDue - deterministic given a clock", () => {
  const base: Automation = { name: "weekly-review", verb: "weekly-review", cadence: "daily", enabled: true };
  it("a disabled automation is never due", () => {
    expect(isDue({ ...base, enabled: false }, 1_000_000)).toBe(false);
  });
  it("a never-run, enabled automation is due immediately", () => {
    expect(isDue(base, 1_000_000)).toBe(true);
  });
  it("is not due until a full interval has elapsed since lastRun", () => {
    const now = 10 * DAY;
    expect(isDue({ ...base, lastRun: new Date(now - HOUR).toISOString() }, now)).toBe(false);
    expect(isDue({ ...base, lastRun: new Date(now - DAY - 1).toISOString() }, now)).toBe(true);
  });
  it("nextRunMs is lastRun + interval", () => {
    const last = 5 * DAY;
    expect(nextRunMs({ ...base, lastRun: new Date(last).toISOString() }, last)).toBe(last + DAY);
  });
});

describe("AutomationStore - the JSON-backed automations file", () => {
  let dir: string, store: AutomationStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "buildex-auto-"));
    store = new AutomationStore(join(dir, ".automations.json"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds, lists, toggles, records a run, and removes", () => {
    const a = store.add({ name: "friday-review", verb: "weekly-review", cadence: "weekly" });
    expect(a.enabled).toBe(true);
    expect(store.list()).toHaveLength(1);

    const off = store.update("friday-review", { enabled: false });
    expect(off.enabled).toBe(false);

    store.update("friday-review", { lastRun: new Date(DAY).toISOString() });
    expect(store.list()[0]!.lastRun).toBe(new Date(DAY).toISOString());

    store.remove("friday-review");
    expect(store.list()).toHaveLength(0);
  });

  it("refuses a duplicate name and a non-kebab name", () => {
    store.add({ name: "tidy", verb: "tidy", cadence: "daily" });
    expect(() => store.add({ name: "tidy", verb: "tidy", cadence: "daily" })).toThrow(/exists/i);
    expect(() => store.add({ name: "Not Kebab", verb: "tidy", cadence: "daily" })).toThrow(/name/i);
  });
});

describe("automations.yaml definitions", () => {
  const sample: AutomationDef[] = [
    { name: "weekly-review", verb: "weekly-review", cadence: "weekly", enabled: true, catchUp: "coalesce" },
    { name: "nightly-digest", verb: "daily-digest", cadence: "daily", enabled: false, catchUp: "each" },
  ];

  it("round-trips defs through serialize → parse", () => {
    const text = serializeAutomationsYaml(sample);
    expect(parseAutomationsYaml(text)).toEqual(sample);
  });

  it("defaults enabled=true and catchUp=coalesce when omitted", () => {
    const text = "- name: a\n  verb: tidy\n  cadence: hourly\n";
    expect(parseAutomationsYaml(text)).toEqual([
      { name: "a", verb: "tidy", cadence: "hourly", enabled: true, catchUp: "coalesce" },
    ]);
  });

  it("skips malformed entries (missing verb) without throwing", () => {
    const text = "- name: bad\n  cadence: daily\n- name: ok\n  verb: tidy\n  cadence: daily\n";
    expect(parseAutomationsYaml(text).map((d) => d.name)).toEqual(["ok"]);
  });
});

describe("AutomationDefStore + migration", () => {
  it("add/update/remove persists as YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-"));
    const store = new AutomationDefStore(join(dir, "automations.yaml"));
    store.add({ name: "weekly-review", verb: "weekly-review", cadence: "weekly" });
    expect(store.list()[0]).toMatchObject({ name: "weekly-review", catchUp: "coalesce", enabled: true });
    store.update("weekly-review", { enabled: false });
    expect(store.list()[0]!.enabled).toBe(false);
    store.remove("weekly-review");
    expect(store.list()).toEqual([]);
  });

  it("migrates a legacy .automations.json to automations.yaml once", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-"));
    const jsonFile = join(dir, ".automations.json");
    const yamlFile = join(dir, "automations.yaml");
    writeFileSync(jsonFile, JSON.stringify([{ name: "wr", verb: "weekly-review", cadence: "weekly", enabled: true }]));
    expect(migrateJsonToYaml(jsonFile, yamlFile)).toBe(true);
    expect(existsSync(yamlFile)).toBe(true);
    expect(parseAutomationsYaml(readFileSync(yamlFile, "utf8"))).toEqual([
      { name: "wr", verb: "weekly-review", cadence: "weekly", enabled: true, catchUp: "coalesce" },
    ]);
    // second call is a no-op (yaml already present)
    expect(migrateJsonToYaml(jsonFile, yamlFile)).toBe(false);
  });
});

describe("AutomationStateFile (local-only run stamps)", () => {
  it("get returns undefined before set, then the stored ms; persists across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-state-"));
    const file = join(dir, ".automations-state.json");
    const s = new AutomationStateFile(file);
    expect(s.get("digest")).toBeUndefined();
    s.set("digest", 12345);
    expect(s.get("digest")).toBe(12345);
    expect(new AutomationStateFile(file).get("digest")).toBe(12345); // persisted
  });
});
