// The loop clock, as a table. Every case pins wall-clock behaviour an operator can feel: when a
// fresh loop first fires, that missed windows collapse to one run, that a stale time-of-day window
// is skipped rather than run at the wrong hour, and that a DST day neither double-fires nor stalls.
//
// TZ is pinned per-case (Node re-reads process.env.TZ on each Date operation), because "9am" is
// only meaningful against a zone and the DST cases are the whole point.
import { describe, it, expect, afterEach } from "vitest";
import { parseEvery, nextFire, dueness, scheduleSentence, LATE_FIRE_MS } from "./loops-schedule.js";
import type { LoopSchedule } from "./loops.js";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

/** Local-time helper: build an ms timestamp from wall-clock parts in the ambient TZ. */
function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("parseEvery", () => {
  it("reads minute, hour and day tokens", () => {
    expect(parseEvery("30m")).toBe(30 * MIN);
    expect(parseEvery("2h")).toBe(2 * HOUR);
    expect(parseEvery("1d")).toBe(24 * HOUR);
    expect(parseEvery(" 45m ")).toBe(45 * MIN);
  });

  it("rejects anything below the 5-minute floor, so a typo cannot spawn an agent storm", () => {
    expect(parseEvery("1m")).toBeNull();
    expect(parseEvery("0m")).toBeNull();
    expect(parseEvery("5m")).toBe(5 * MIN);
  });

  it("rejects malformed tokens rather than guessing", () => {
    for (const bad of ["", "m", "30", "30s", "-2h", "two hours", "1w"]) {
      expect(parseEvery(bad)).toBeNull();
    }
  });
});

describe("nextFire — interval loops", () => {
  const every30m: LoopSchedule = { kind: "every", ms: 30 * MIN, raw: "30m" };

  it("a never-run loop first fires one interval after it was first seen, not immediately", () => {
    const firstSeen = local(2026, 7, 23, 14, 0);
    expect(nextFire(every30m, { firstSeen }, firstSeen)).toBe(firstSeen + 30 * MIN);
  });

  it("counts from the last run once there is one", () => {
    const firstSeen = local(2026, 7, 23, 14, 0);
    const lastRun = local(2026, 7, 23, 15, 10);
    expect(nextFire(every30m, { firstSeen, lastRun }, lastRun + MIN)).toBe(lastRun + 30 * MIN);
  });

  it("reports `now` when the window has already passed - it is due, not overdue by n windows", () => {
    const firstSeen = local(2026, 7, 23, 9, 0);
    const lastRun = local(2026, 7, 23, 9, 0);
    const now = local(2026, 7, 23, 17, 0); // eight hours and sixteen missed windows later
    expect(nextFire(every30m, { firstSeen, lastRun }, now)).toBe(now);
  });
});

describe("nextFire — time-of-day loops", () => {
  const at9: LoopSchedule = { kind: "at", hour: 9, minute: 0, days: [] };
  const mondays: LoopSchedule = { kind: "at", hour: 9, minute: 0, days: ["mon"] };

  it("finds today's window when it is still ahead", () => {
    process.env.TZ = "Europe/Zagreb";
    const now = local(2026, 7, 23, 6, 30);
    expect(nextFire(at9, { firstSeen: now }, now)).toBe(local(2026, 7, 23, 9, 0));
  });

  it("rolls to tomorrow once today's window has passed", () => {
    process.env.TZ = "Europe/Zagreb";
    const now = local(2026, 7, 23, 9, 30);
    expect(nextFire(at9, { firstSeen: now }, now)).toBe(local(2026, 7, 24, 9, 0));
  });

  it("skips to the next allowed weekday", () => {
    process.env.TZ = "Europe/Zagreb";
    const thursday = local(2026, 7, 23, 12, 0); // 2026-07-23 is a Thursday
    expect(new Date(thursday).getDay()).toBe(4);
    expect(nextFire(mondays, { firstSeen: thursday }, thursday)).toBe(local(2026, 7, 27, 9, 0));
  });
});

describe("dueness — interval loops", () => {
  const every30m: LoopSchedule = { kind: "every", ms: 30 * MIN, raw: "30m" };

  it("is not due before its first window, and is due at it", () => {
    const firstSeen = local(2026, 7, 23, 14, 0);
    expect(dueness(every30m, { firstSeen }, firstSeen + 29 * MIN)).toEqual({ due: false });
    expect(dueness(every30m, { firstSeen }, firstSeen + 30 * MIN)).toEqual({ due: true });
  });

  it("coalesces missed windows into a single run - a closed laptop never yields a burst", () => {
    const firstSeen = local(2026, 7, 23, 9, 0);
    const lastRun = firstSeen;
    // Sixteen windows elapsed while the app was shut. Exactly one run is owed.
    const now = local(2026, 7, 23, 17, 0);
    expect(dueness(every30m, { firstSeen, lastRun }, now)).toEqual({ due: true });
    expect(dueness(every30m, { firstSeen, lastRun: now }, now)).toEqual({ due: false });
  });

  it("never reports an interval window as missed - an interval has no wall clock to go stale against", () => {
    const firstSeen = local(2026, 1, 1, 0, 0);
    const now = local(2026, 7, 23, 17, 0); // most of a year late
    expect(dueness(every30m, { firstSeen, lastRun: firstSeen }, now)).toEqual({ due: true });
  });
});

describe("dueness — time-of-day loops", () => {
  const at9: LoopSchedule = { kind: "at", hour: 9, minute: 0, days: [] };
  const mondays: LoopSchedule = { kind: "at", hour: 9, minute: 0, days: ["mon"] };

  it("fires at its window and not before", () => {
    process.env.TZ = "Europe/Zagreb";
    const firstSeen = local(2026, 7, 22, 20, 0);
    expect(dueness(at9, { firstSeen }, local(2026, 7, 23, 8, 59))).toEqual({ due: false });
    expect(dueness(at9, { firstSeen }, local(2026, 7, 23, 9, 0))).toEqual({ due: true });
  });

  it("does not re-fire the same window after it has run", () => {
    process.env.TZ = "Europe/Zagreb";
    const firstSeen = local(2026, 7, 22, 20, 0);
    const lastRun = local(2026, 7, 23, 9, 0);
    expect(dueness(at9, { firstSeen, lastRun }, local(2026, 7, 23, 11, 0))).toEqual({ due: false });
  });

  it("still fires a little late - a laptop opened at 10:30 gets its 9am run", () => {
    process.env.TZ = "Europe/Zagreb";
    const firstSeen = local(2026, 7, 22, 20, 0);
    expect(dueness(at9, { firstSeen }, local(2026, 7, 23, 10, 30))).toEqual({ due: true });
  });

  it("marks a stale window missed instead of running the 9am draft at 8pm", () => {
    process.env.TZ = "Europe/Zagreb";
    const firstSeen = local(2026, 7, 22, 20, 0);
    const now = local(2026, 7, 23, 20, 0);
    expect(now - local(2026, 7, 23, 9, 0)).toBeGreaterThan(LATE_FIRE_MS);
    expect(dueness(at9, { firstSeen }, now)).toEqual({ due: false, missed: local(2026, 7, 23, 9, 0) });
  });

  it("a window before the loop existed is neither due nor missed", () => {
    process.env.TZ = "Europe/Zagreb";
    const firstSeen = local(2026, 7, 23, 12, 0); // created after today's 9am
    expect(dueness(at9, { firstSeen }, local(2026, 7, 23, 12, 30))).toEqual({ due: false });
  });

  it("ignores days outside its list", () => {
    process.env.TZ = "Europe/Zagreb";
    const firstSeen = local(2026, 7, 22, 20, 0);
    const thursday9am = local(2026, 7, 23, 9, 0);
    expect(dueness(mondays, { firstSeen }, thursday9am)).toEqual({ due: false });
    const monday9am = local(2026, 7, 27, 9, 0);
    expect(new Date(monday9am).getDay()).toBe(1);
    expect(dueness(mondays, { firstSeen }, monday9am)).toEqual({ due: true });
  });
});

describe("dueness — daylight saving", () => {
  // Europe/Zagreb springs forward 2026-03-29 (02:00 → 03:00) and falls back 2026-10-25.
  const at9: LoopSchedule = { kind: "at", hour: 9, minute: 0, days: [] };

  it("fires exactly once across a spring-forward day", () => {
    process.env.TZ = "Europe/Zagreb";
    const firstSeen = local(2026, 3, 28, 20, 0);
    const window = local(2026, 3, 29, 9, 0);
    expect(dueness(at9, { firstSeen }, window)).toEqual({ due: true });
    expect(dueness(at9, { firstSeen, lastRun: window }, window + HOUR)).toEqual({ due: false });
    // ...and the next window is the following morning, one 23-hour day later.
    expect(nextFire(at9, { firstSeen, lastRun: window }, window + HOUR)).toBe(local(2026, 3, 30, 9, 0));
  });

  it("fires exactly once across a fall-back day", () => {
    process.env.TZ = "Europe/Zagreb";
    const firstSeen = local(2026, 10, 24, 20, 0);
    const window = local(2026, 10, 25, 9, 0);
    expect(dueness(at9, { firstSeen }, window)).toEqual({ due: true });
    expect(dueness(at9, { firstSeen, lastRun: window }, window + HOUR)).toEqual({ due: false });
    expect(nextFire(at9, { firstSeen, lastRun: window }, window + HOUR)).toBe(local(2026, 10, 26, 9, 0));
  });

  it("a 2:30am window on a spring-forward day still resolves to a real instant", () => {
    process.env.TZ = "Europe/Zagreb";
    const at230: LoopSchedule = { kind: "at", hour: 2, minute: 30, days: [] };
    const firstSeen = local(2026, 3, 28, 20, 0);
    const fire = nextFire(at230, { firstSeen }, local(2026, 3, 28, 21, 0));
    expect(Number.isFinite(fire)).toBe(true);
    // 02:30 does not exist on 2026-03-29 in this zone; it normalises forward into the same morning.
    expect(fire).toBeGreaterThan(local(2026, 3, 28, 21, 0));
    expect(fire).toBeLessThan(local(2026, 3, 29, 12, 0));
  });
});

describe("scheduleSentence", () => {
  it("renders intervals the way an operator would say them", () => {
    expect(scheduleSentence({ kind: "every", ms: 30 * MIN, raw: "30m" })).toBe("every 30 minutes");
    expect(scheduleSentence({ kind: "every", ms: HOUR, raw: "1h" })).toBe("every hour");
    expect(scheduleSentence({ kind: "every", ms: 2 * HOUR, raw: "2h" })).toBe("every 2 hours");
    expect(scheduleSentence({ kind: "every", ms: 24 * HOUR, raw: "1d" })).toBe("every day");
  });

  it("renders times of day, with and without a day list", () => {
    expect(scheduleSentence({ kind: "at", hour: 9, minute: 0, days: [] })).toBe("every day at 9:00 AM");
    expect(scheduleSentence({ kind: "at", hour: 9, minute: 0, days: ["mon"] })).toBe("every Monday at 9:00 AM");
    expect(scheduleSentence({ kind: "at", hour: 17, minute: 30, days: ["mon", "wed", "fri"] })).toBe(
      "every Monday, Wednesday and Friday at 5:30 PM",
    );
    expect(scheduleSentence({ kind: "at", hour: 0, minute: 5, days: ["sat", "sun"] })).toBe(
      "every Saturday and Sunday at 12:05 AM",
    );
  });

  it("names the weekday set an operator actually has a word for", () => {
    expect(scheduleSentence({ kind: "at", hour: 9, minute: 0, days: ["mon", "tue", "wed", "thu", "fri"] })).toBe(
      "every weekday at 9:00 AM",
    );
  });
});
