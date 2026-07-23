// Loops - what the operator schedules to run on its own. A loop is a prompt (or a verb) plus a
// schedule; firing one spawns an ordinary agent session, so the transcript and the gate work
// unchanged. NOT the company-level activity log invariant 5 calls for - that surface does not exist
// yet, and a loop run is exactly the kind of unattended action it will need to carry.
//
// Definitions live in a COMMITTED loops.yaml (invariant 2): reviewable in history, and they follow
// the operator to a new machine. Run state - last run, status, the session it produced - lives in an
// uncommitted state file beside the workspace, because scheduling churn must never touch the brain.
//
// The reader is deliberately tolerant (hand-edited file, no js-yaml dependency) and deliberately
// strict about what it accepts: an item it cannot honour exactly is skipped, never guessed at, so a
// typo can never silently reschedule the operator's company.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseEvery, MIN_EVERY_MS } from "./loops-schedule.js";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Either a fixed interval, or a wall-clock time on chosen days (empty `days` = every day). */
export type LoopSchedule =
  | { kind: "every"; ms: number; raw: string }
  | { kind: "at"; hour: number; minute: number; days: Weekday[] };

export interface LoopDef {
  name: string;
  title: string;
  /** Exactly one of `prompt` / `verb` is set. */
  prompt?: string;
  verb?: string;
  schedule: LoopSchedule;
  enabled: boolean;
}

export type LoopStatus = "ok" | "failed" | "needs-approval" | "missed" | "running";

export interface LoopRunState {
  /** Whether THIS machine runs this loop. Absent/false means no - a definition arriving by sync is
   *  inert until the operator switches it on here. The whole point: loops.yaml is shared, so without
   *  a per-machine opt-in every open laptop in the company would fire the same loop independently. */
  activeHere?: boolean;
  /** When this loop was switched on here - the anchor a never-run loop counts from. */
  firstSeen?: number;
  lastRun?: number;
  status?: LoopStatus;
  sessionId?: string;
  /** What the last run needed a human for, when it ended `needs-approval`. */
  blockedOn?: string;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const WEEK_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/* ---------- loops.yaml ---------- */

/** Read the flat `- key: value` loops file. Unknown keys ignored; unhonourable items skipped. */
export function parseLoopsYaml(text: string): LoopDef[] {
  const out: LoopDef[] = [];
  let cur: Record<string, string> | null = null;
  const flush = () => {
    if (cur) {
      const def = toDef(cur);
      if (def) out.push(def);
    }
    cur = null;
  };
  for (const raw of text.split("\n")) {
    // Strip trailing comments only outside a value - a prompt may legitimately contain "#".
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const item = /^-\s+(\w+):\s*(.*)$/.exec(line);
    if (item) {
      flush();
      cur = { [item[1]!]: unquote(item[2]!) };
      continue;
    }
    const kv = /^\s+(\w+):\s*(.*)$/.exec(line);
    if (kv && cur) cur[kv[1]!] = unquote(kv[2]!);
  }
  flush();
  return out;
}

/** One parsed block → a def, or null when it cannot be honoured exactly as written. */
function toDef(raw: Record<string, string>): LoopDef | null {
  const name = raw["name"];
  if (!name || !NAME_RE.test(name)) return null;

  const prompt = raw["prompt"]?.trim() || undefined;
  const verb = raw["verb"]?.trim() || undefined;
  if ((prompt && verb) || (!prompt && !verb)) return null; // exactly one body

  const schedule = toSchedule(raw);
  if (!schedule) return null;

  return {
    name,
    title: raw["title"]?.trim() || name,
    ...(prompt ? { prompt } : {}),
    ...(verb ? { verb } : {}),
    schedule,
    enabled: raw["enabled"] !== "false",
  };
}

/** Build a schedule from the three wire/YAML fields. Null when it cannot be honoured exactly - the
 *  yaml reader skips such an item, the HTTP route answers 400. One implementation, both callers. */
export function parseScheduleInput(input: { every?: string; at?: string; days?: string }): LoopSchedule | null {
  const every = input.every?.trim();
  const at = input.at?.trim();
  if ((every && at) || (!every && !at)) return null; // exactly one schedule

  if (every) {
    const ms = parseEvery(every);
    return ms === null ? null : { kind: "every", ms, raw: every };
  }
  const t = /^(\d{1,2}):(\d{2})$/.exec(at!);
  if (!t) return null;
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  if (hour > 23 || minute > 59) return null;
  return { kind: "at", hour, minute, days: parseDays(input.days) };
}

function toSchedule(raw: Record<string, string>): LoopSchedule | null {
  return parseScheduleInput({
    ...(raw["every"] !== undefined ? { every: raw["every"] } : {}),
    ...(raw["at"] !== undefined ? { at: raw["at"] } : {}),
    ...(raw["days"] !== undefined ? { days: raw["days"] } : {}),
  });
}

/** `Fri, mon,WED` → ["mon","wed","fri"] - deduped and in week order, so the sentence reads right. */
function parseDays(raw: string | undefined): Weekday[] {
  if (!raw) return [];
  const wanted = new Set(
    raw
      .split(",")
      .map((d) => d.trim().toLowerCase().slice(0, 3))
      .filter((d): d is Weekday => (WEEK_ORDER as string[]).includes(d)),
  );
  return WEEK_ORDER.filter((d) => wanted.has(d));
}

export function serializeLoopsYaml(defs: LoopDef[]): string {
  return defs
    .map((d) => {
      const lines = [`- name: ${d.name}`, `  title: ${quote(d.title)}`];
      if (d.prompt) lines.push(`  prompt: ${quote(d.prompt)}`);
      if (d.verb) lines.push(`  verb: ${d.verb}`);
      if (d.schedule.kind === "every") {
        lines.push(`  every: ${d.schedule.raw}`);
      } else {
        lines.push(`  at: "${String(d.schedule.hour).padStart(2, "0")}:${String(d.schedule.minute).padStart(2, "0")}"`);
        if (d.schedule.days.length) lines.push(`  days: ${d.schedule.days.join(", ")}`);
      }
      lines.push(`  enabled: ${d.enabled}`);
      return lines.join("\n") + "\n";
    })
    .join("\n");
}

/** Quote any value whose punctuation would confuse a reader (ours or a human's) on the way back. */
function quote(v: string): string {
  return /[:#"']/.test(v) || v !== v.trim() ? JSON.stringify(v) : v;
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    if (t.startsWith('"')) {
      try {
        return JSON.parse(t) as string;
      } catch {
        /* fall through to the naive strip */
      }
    }
    return t.slice(1, -1);
  }
  return t;
}

/* ---------- the definition store ---------- */

export interface NewLoop {
  title: string;
  prompt?: string;
  verb?: string;
  schedule: LoopSchedule;
  enabled?: boolean;
}

export class LoopDefStore {
  constructor(private readonly file: string) {}

  list(): LoopDef[] {
    try {
      return parseLoopsYaml(readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
  }

  add(input: NewLoop): LoopDef {
    const prompt = input.prompt?.trim() || undefined;
    const verb = input.verb?.trim() || undefined;
    if ((prompt && verb) || (!prompt && !verb)) throw new Error("a loop needs a prompt or a verb, not both");
    if (input.schedule.kind === "every" && input.schedule.ms < MIN_EVERY_MS) {
      throw new Error("a loop may not run more often than every 5 minutes");
    }
    const list = this.list();
    const def: LoopDef = {
      name: uniqueName(input.title, new Set(list.map((l) => l.name))),
      title: input.title.trim() || "Untitled loop",
      ...(prompt ? { prompt } : {}),
      ...(verb ? { verb } : {}),
      schedule: input.schedule,
      enabled: input.enabled ?? true,
    };
    list.push(def);
    this.save(list);
    return def;
  }

  update(name: string, patch: Partial<Omit<LoopDef, "name">>): LoopDef {
    const list = this.list();
    const i = list.findIndex((l) => l.name === name);
    if (i < 0) throw new Error(`loop not found: ${name}`);
    list[i] = { ...list[i]!, ...patch };
    this.save(list);
    return list[i]!;
  }

  remove(name: string): void {
    this.save(this.list().filter((l) => l.name !== name));
  }

  private save(list: LoopDef[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, serializeLoopsYaml(list));
  }
}

/** Kebab-case the title into a stable identity, suffixing on collision (`weekly-review-2`). */
function uniqueName(title: string, taken: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(\d)/, "loop-$1") || "loop";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/* ---------- run state (never committed) ---------- */

export class LoopStateFile {
  constructor(private readonly file: string) {}

  private read(): Record<string, LoopRunState> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, LoopRunState>) : {};
    } catch {
      return {}; // a corrupt stamp file costs at most one duplicate run, never a crash
    }
  }

  get(name: string): LoopRunState | undefined {
    return this.read()[name];
  }

  all(): Record<string, LoopRunState> {
    return this.read();
  }

  /** Merge `patch` into a loop's state. An explicit `undefined` clears that field. */
  set(name: string, patch: LoopRunState): void {
    const map = this.read();
    const merged = { ...map[name], ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k as keyof LoopRunState];
    map[name] = merged;
    this.write(map);
  }

  /** Forget state for loops that no longer exist, so a deleted-and-recreated name starts clean. */
  prune(keep: Set<string>): void {
    const map = this.read();
    let changed = false;
    for (const name of Object.keys(map)) {
      if (!keep.has(name)) {
        delete map[name];
        changed = true;
      }
    }
    if (changed) this.write(map);
  }

  private write(map: Record<string, LoopRunState>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(map, null, 2) + "\n");
  }
}

/* ---------- migration ---------- */

const LEGACY_CADENCE: Record<string, { ms: number; raw: string }> = {
  hourly: { ms: 3_600_000, raw: "1h" },
  daily: { ms: 86_400_000, raw: "1d" },
  weekly: { ms: 604_800_000, raw: "7d" },
};

/** One-time lift of the legacy automations.yaml into loops.yaml. Returns true only when it wrote a
 *  new file. The legacy file is left exactly where it is (invariant 8 - never destroy the
 *  operator's work); it simply stops being read. */
export function migrateAutomationsYaml(legacyFile: string, loopsFile: string): boolean {
  if (existsSync(loopsFile) || !existsSync(legacyFile)) return false;
  let text: string;
  try {
    text = readFileSync(legacyFile, "utf8");
  } catch {
    return false;
  }
  const defs: LoopDef[] = [];
  for (const block of text.split(/\n(?=- )/)) {
    const name = /^-\s+name:\s*(.*)$/m.exec(block)?.[1]?.trim();
    const verb = /^\s*verb:\s*(.*)$/m.exec(block)?.[1]?.trim();
    const cadence = /^\s*cadence:\s*(.*)$/m.exec(block)?.[1]?.trim();
    const enabled = /^\s*enabled:\s*(.*)$/m.exec(block)?.[1]?.trim();
    const every = cadence ? LEGACY_CADENCE[cadence] : undefined;
    if (!name || !NAME_RE.test(name) || !verb || !every) continue;
    defs.push({
      name,
      title: name,
      verb,
      schedule: { kind: "every", ms: every.ms, raw: every.raw },
      enabled: enabled !== "false",
    });
  }
  mkdirSync(dirname(loopsFile), { recursive: true });
  writeFileSync(loopsFile, serializeLoopsYaml(defs));
  return true;
}
