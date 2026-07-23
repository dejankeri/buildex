// The loop clock. Pure functions over (schedule, run state, now) - no timers, no I/O, no ambient
// Date - so the whole firing policy is a table test (loops-schedule.test.ts).
//
// Two rules shape everything here, and both exist to protect the operator from surprise:
//   - Coalesce. A closed laptop owes ONE run per loop, never a burst of the windows it slept through.
//   - Don't run stale work. A 9am draft that surfaces at 8pm is worse than no draft, so a
//     time-of-day window that has gone cold is recorded as missed instead of fired.
import type { LoopSchedule, Weekday } from "./loops.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The smallest interval a loop may use. A typo'd `1m` would spawn an agent a minute, forever. */
export const MIN_EVERY_MS = 5 * MIN;

/** How late a time-of-day window may still fire. Past this it is recorded missed, not run. */
export const LATE_FIRE_MS = 4 * HOUR;

/** Run state the clock needs. `firstSeen` is the anchor: stamped when a loop is switched on for THIS
 *  machine, so a loop turned on at 2pm with a 9am window waits for tomorrow rather than firing on
 *  the spot. */
export interface LoopClockState {
  firstSeen: number;
  lastRun?: number;
}

/** Where the clock counts from: the later of "last actually ran" and "switched on here". Taking the
 *  MAX is what stops a loop that ran months ago on another machine from being instantly due the
 *  moment this machine adopts it. */
function anchor(state: LoopClockState): number {
  return Math.max(state.lastRun ?? 0, state.firstSeen);
}

/** Parse an `every:` token (`30m`, `2h`, `1d`) to ms. Null when malformed or under the floor. */
export function parseEvery(raw: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { m: MIN, h: HOUR, d: DAY }[m[2] as "m" | "h" | "d"]!;
  const ms = n * unit;
  return ms >= MIN_EVERY_MS ? ms : null;
}

const WEEK: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Whether a local-time instant falls on one of the schedule's days (an empty list means any day). */
function onDay(days: Weekday[], ms: number): boolean {
  return days.length === 0 || days.includes(WEEK[new Date(ms).getDay()]!);
}

/** The wall-clock instant of `hour:minute` on the local calendar day containing `ms`.
 *  Local-time construction is deliberate: it is what makes "9am" survive a DST shift, and it is why
 *  a window that does not exist on a spring-forward day normalises forward into the same morning
 *  instead of throwing or silently vanishing. */
function windowOn(ms: number, hour: number, minute: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
}

/** The latest window at or before `now`, searching back up to a week. Null if the loop has none. */
function lastWindowAtOrBefore(s: Extract<LoopSchedule, { kind: "at" }>, now: number): number | null {
  for (let back = 0; back <= 8; back++) {
    const candidate = windowOn(now - back * DAY, s.hour, s.minute);
    if (candidate <= now && onDay(s.days, candidate)) return candidate;
  }
  return null;
}

/** The next window strictly after `now`, searching forward up to a week. */
function nextWindowAfter(s: Extract<LoopSchedule, { kind: "at" }>, now: number): number {
  for (let ahead = 0; ahead <= 8; ahead++) {
    const candidate = windowOn(now + ahead * DAY, s.hour, s.minute);
    if (candidate > now && onDay(s.days, candidate)) return candidate;
  }
  return now + DAY; // unreachable for any valid day list; never return NaN to the UI
}

/** When this loop next runs, as an ms timestamp. Returns `now` when it is already due. */
export function nextFire(schedule: LoopSchedule, state: LoopClockState, now: number): number {
  if (schedule.kind === "every") {
    const fire = anchor(state) + schedule.ms;
    return fire <= now ? now : fire;
  }
  const due = dueness(schedule, state, now);
  if (due.due) return now;
  return nextWindowAfter(schedule, now);
}

/** Whether the loop owes a run right now. `missed` carries the window that went cold unrun, so the
 *  caller can record it and move the stamp on rather than reconsidering it every tick. */
export function dueness(
  schedule: LoopSchedule,
  state: LoopClockState,
  now: number,
): { due: boolean; missed?: number } {
  if (schedule.kind === "every") {
    return { due: now - anchor(state) >= schedule.ms };
  }
  const window = lastWindowAtOrBefore(schedule, now);
  // Nothing owed if there is no window yet, if it predates the loop, or if it already ran.
  if (window === null) return { due: false };
  if (window < state.firstSeen) return { due: false };
  if (state.lastRun !== undefined && state.lastRun >= window) return { due: false };
  if (now - window > LATE_FIRE_MS) return { due: false, missed: window };
  return { due: true };
}

const DAY_NAMES: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

/** The schedule as the operator would say it out loud. Rendered here, not in the console, so the
 *  string is testable and there is exactly one phrasing of any schedule in the product. */
export function scheduleSentence(schedule: LoopSchedule): string {
  if (schedule.kind === "every") return `every ${interval(schedule.ms)}`;
  return `${days(schedule.days)} at ${clock(schedule.hour, schedule.minute)}`;
}

function interval(ms: number): string {
  if (ms % DAY === 0) {
    const n = ms / DAY;
    return n === 1 ? "day" : `${n} days`;
  }
  if (ms % HOUR === 0) {
    const n = ms / HOUR;
    return n === 1 ? "hour" : `${n} hours`;
  }
  const n = Math.round(ms / MIN);
  return n === 1 ? "minute" : `${n} minutes`;
}

function days(list: Weekday[]): string {
  if (list.length === 0) return "every day";
  if (list.length === 5 && WEEKDAYS.every((d) => list.includes(d))) return "every weekday";
  const names = list.map((d) => DAY_NAMES[d]);
  if (names.length === 1) return `every ${names[0]}`;
  return `every ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** 12-hour clock, the way a non-technical operator reads a time. */
function clock(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
}
