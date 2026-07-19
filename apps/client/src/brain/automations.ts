// Automations - verbs the operator schedules to run on their own. The
// definitions + last-run stamps live in a local JSON file (like the session store), not the repo, so
// scheduling churn never pollutes the brain. Durable, portable, cloud-side cron is the production
// path (the sync worker); this in-daemon scheduler runs verbs while the app is open.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type Cadence = "hourly" | "daily" | "weekly";

export interface Automation {
  name: string;
  /** The verb (skill) this automation runs. */
  verb: string;
  cadence: Cadence;
  enabled: boolean;
  /** ISO timestamp of the last run, if any. */
  lastRun?: string;
}

const HOUR = 3600_000;
const INTERVAL: Record<Cadence, number> = { hourly: HOUR, daily: 24 * HOUR, weekly: 7 * 24 * HOUR };

export function cadenceMs(c: Cadence): number {
  return INTERVAL[c] ?? INTERVAL.daily;
}

/** Whether an automation should run at `nowMs` (enabled + a full interval elapsed since lastRun). */
export function isDue(a: Automation, nowMs: number): boolean {
  if (!a.enabled) return false;
  if (!a.lastRun) return true;
  const last = Date.parse(a.lastRun);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= cadenceMs(a.cadence);
}

/** The next scheduled run as an ms timestamp (nowMs for a never-run automation). */
export function nextRunMs(a: Automation, nowMs: number): number {
  if (!a.lastRun) return nowMs;
  const last = Date.parse(a.lastRun);
  return (Number.isNaN(last) ? nowMs : last) + cadenceMs(a.cadence);
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export class AutomationStore {
  constructor(private readonly file: string) {}

  list(): Automation[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(parsed) ? (parsed as Automation[]) : [];
    } catch {
      return [];
    }
  }

  add(input: { name: string; verb: string; cadence: Cadence; enabled?: boolean }): Automation {
    if (!NAME_RE.test(input.name)) throw new Error(`invalid automation name (must be kebab-case): ${input.name}`);
    const list = this.list();
    if (list.some((a) => a.name === input.name)) throw new Error(`automation exists: ${input.name}`);
    const rec: Automation = { name: input.name, verb: input.verb, cadence: input.cadence, enabled: input.enabled ?? true };
    list.push(rec);
    this.save(list);
    return rec;
  }

  update(name: string, patch: Partial<Omit<Automation, "name">>): Automation {
    const list = this.list();
    const i = list.findIndex((a) => a.name === name);
    if (i < 0) throw new Error(`automation not found: ${name}`);
    list[i] = { ...list[i]!, ...patch };
    this.save(list);
    return list[i]!;
  }

  remove(name: string): void {
    this.save(this.list().filter((a) => a.name !== name));
  }

  private save(list: Automation[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(list, null, 2) + "\n");
  }
}

export type CatchUp = "coalesce" | "each";

export interface AutomationDef {
  name: string;
  verb: string;
  cadence: Cadence;
  enabled: boolean;
  catchUp: CatchUp;
}

const CADENCES: Cadence[] = ["hourly", "daily", "weekly"];

/** A tiny tolerant reader for our flat "- name: …" automations.yaml (no js-yaml dependency).
 *  Each list item is a block of `key: value` lines; unknown keys are ignored; malformed items skipped. */
export function parseAutomationsYaml(text: string): AutomationDef[] {
  const out: AutomationDef[] = [];
  let cur: Record<string, string> | null = null;
  const flush = () => {
    if (!cur) return;
    const name = cur["name"];
    const verb = cur["verb"];
    const cadence = cur["cadence"] as Cadence;
    if (name && NAME_RE.test(name) && verb && CADENCES.includes(cadence)) {
      out.push({
        name,
        verb,
        cadence,
        enabled: cur["enabled"] !== "false",
        catchUp: cur["catchUp"] === "each" ? "each" : "coalesce",
      });
    }
    cur = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const item = line.match(/^-\s+(\w+):\s*(.*)$/);
    if (item) {
      flush();
      cur = {};
      cur[item[1]!] = stripQuotes(item[2]!);
      continue;
    }
    const kv = line.match(/^\s+(\w+):\s*(.*)$/);
    if (kv && cur) cur[kv[1]!] = stripQuotes(kv[2]!);
  }
  flush();
  return out;
}

function stripQuotes(v: string): string {
  const t = v.trim();
  return t.replace(/^["'](.*)["']$/, "$1");
}

export function serializeAutomationsYaml(defs: AutomationDef[]): string {
  return (
    defs
      .map(
        (d) =>
          `- name: ${d.name}\n  verb: ${d.verb}\n  cadence: ${d.cadence}\n` +
          `  enabled: ${d.enabled}\n  catchUp: ${d.catchUp}\n`,
      )
      .join("") || ""
  );
}

export class AutomationDefStore {
  constructor(private readonly file: string) {}

  list(): AutomationDef[] {
    try {
      return parseAutomationsYaml(readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  save(defs: AutomationDef[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, serializeAutomationsYaml(defs));
  }

  add(input: { name: string; verb: string; cadence: Cadence; catchUp?: CatchUp; enabled?: boolean }): AutomationDef {
    if (!NAME_RE.test(input.name)) throw new Error(`invalid automation name (must be kebab-case): ${input.name}`);
    const list = this.list();
    if (list.some((a) => a.name === input.name)) throw new Error(`automation exists: ${input.name}`);
    const rec: AutomationDef = {
      name: input.name,
      verb: input.verb,
      cadence: input.cadence,
      enabled: input.enabled ?? true,
      catchUp: input.catchUp ?? "coalesce",
    };
    list.push(rec);
    this.save(list);
    return rec;
  }

  update(name: string, patch: Partial<Omit<AutomationDef, "name">>): AutomationDef {
    const list = this.list();
    const i = list.findIndex((a) => a.name === name);
    if (i < 0) throw new Error(`automation not found: ${name}`);
    list[i] = { ...list[i]!, ...patch };
    this.save(list);
    return list[i]!;
  }

  remove(name: string): void {
    this.save(this.list().filter((a) => a.name !== name));
  }
}

/** One-time migration of the legacy daemon-owned .automations.json to the committed automations.yaml.
 *  Returns true only when it actually wrote a new yaml (json present, yaml absent). Never deletes JSON. */
export function migrateJsonToYaml(jsonFile: string, yamlFile: string): boolean {
  if (existsSync(yamlFile) || !existsSync(jsonFile)) return false;
  let legacy: Automation[];
  try {
    const parsed = JSON.parse(readFileSync(jsonFile, "utf8"));
    legacy = Array.isArray(parsed) ? (parsed as Automation[]) : [];
  } catch {
    return false;
  }
  const defs: AutomationDef[] = legacy
    .filter((a) => a && a.name && a.verb && CADENCES.includes(a.cadence))
    .map((a) => ({ name: a.name, verb: a.verb, cadence: a.cadence, enabled: a.enabled ?? true, catchUp: "coalesce" as CatchUp }));
  mkdirSync(dirname(yamlFile), { recursive: true });
  writeFileSync(yamlFile, serializeAutomationsYaml(defs));
  return true;
}

/** Local-only, never-committed last-run stamps for the fallback timer (keeps churn out of the
 *  brain). A flat { name: lastRunMs } JSON alongside the workspace - not the yaml definitions. */
export class AutomationStateFile {
  constructor(private readonly file: string) {}

  private read(): Record<string, number> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  get(name: string): number | undefined {
    return this.read()[name];
  }

  set(name: string, ms: number): void {
    const map = this.read();
    map[name] = ms;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(map, null, 2) + "\n");
  }
}
