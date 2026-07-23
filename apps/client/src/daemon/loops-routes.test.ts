// The /api/loops surface. The console is a thin renderer over this: every string it shows (the
// schedule sentence, the status) is computed here, so these tests are where that contract is pinned.
import { describe, it, expect, beforeEach } from "vitest";
import { createDaemon, type LoopRecord, type LoopInput, type LoopsEngineControl, type LoopSpendRecord } from "./daemon.js";
import { Gate } from "../gate/gate.js";
import { PolicyEngine } from "../gate/policy.js";
import { ApprovalBroker } from "../gate/approval.js";
import type { UiEvent } from "../agent/types.js";

/** The minimum a daemon needs to exist, so these tests only vary the loops engine. */
function base() {
  const broker = new ApprovalBroker({ idFactory: () => "c1", now: () => 0 });
  return {
    workspace: "/tmp/ws",
    roots: [],
    gate: new Gate(new PolicyEngine({ allow: [], ask: [], deny: [], default: "ask" }), broker),
    broker,
    async *runPrompt() {
      yield { kind: "done" } as UiEvent;
    },
    buildMap: () => ({ nodes: [], edges: [] }),
    syncFn: async () => "ok",
  };
}

/** A stand-in engine: enough behaviour to exercise the routes, none of the scheduler. */
function fakeLoops() {
  const rows = new Map<string, LoopRecord>();
  const runs: string[] = [];
  let capUsd: number | undefined;
  const spend = (): LoopSpendRecord => ({
    today: { runs: 2, costUsd: 0.08 },
    month: { runs: 40, costUsd: 1.6 },
    ...(capUsd !== undefined ? { capUsd } : {}),
    overCap: capUsd !== undefined && 0.08 >= capUsd,
  });
  const control: LoopsEngineControl = {
    list: () => [...rows.values()],
    add: (b: LoopInput) => {
      if (!b.every && !b.at) throw new Error("a loop needs either `every` or `at`");
      const name = b.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (rows.has(name)) throw new Error(`loop exists: ${name}`);
      const rec: LoopRecord = {
        name,
        title: b.title,
        ...(b.prompt ? { prompt: b.prompt } : {}),
        ...(b.verb ? { verb: b.verb } : {}),
        scheduleText: b.every ? `every ${b.every}` : `every day at ${b.at}`,
        enabled: b.enabled ?? true,
        activeHere: true, // created here
        nextRun: 1_000,
        runs: [],
      };
      rows.set(name, rec);
      return rec;
    },
    update: (name, patch) => {
      const cur = rows.get(name);
      if (!cur) throw new Error(`loop not found: ${name}`);
      const next = { ...cur, ...patch } as LoopRecord;
      rows.set(name, next);
      return next;
    },
    toggle: (name) => {
      const cur = rows.get(name);
      if (!cur) throw new Error(`loop not found: ${name}`);
      const next = { ...cur, enabled: !cur.enabled };
      rows.set(name, next);
      return next;
    },
    setActiveHere: (name, active) => {
      const cur = rows.get(name);
      if (!cur) throw new Error(`loop not found: ${name}`);
      const next = { ...cur, activeHere: active };
      rows.set(name, next);
      return next;
    },
    remove: (name) => {
      rows.delete(name);
    },
    runNow: async (name) => {
      if (!rows.has(name)) throw new Error(`loop not found: ${name}`);
      runs.push(name);
      return { sessionId: `s-${name}` };
    },
    spend,
    setCap: (usd) => {
      capUsd = usd;
      return spend();
    },
  };
  return { control, runs, rows, cap: () => capUsd };
}

let loops: ReturnType<typeof fakeLoops>;
let daemon: ReturnType<typeof createDaemon>;

beforeEach(() => {
  loops = fakeLoops();
  daemon = createDaemon({ ...base(), loops: loops.control });
});

const post = (path: string, body?: unknown) =>
  daemon(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const patch = (path: string, body: unknown) =>
  daemon(
    new Request(`http://127.0.0.1${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const get = (path: string) => daemon(new Request(`http://127.0.0.1${path}`));

describe("/api/loops", () => {
  it("starts empty", async () => {
    expect(await (await get("/api/loops")).json()).toMatchObject({ loops: [] });
  });

  it("creates a loop and lists it with its schedule already in words", async () => {
    const res = await post("/api/loops", { title: "Weekly review", prompt: "draft it", at: "09:00" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "weekly-review", scheduleText: "every day at 09:00", enabled: true });

    const listed = (await (await get("/api/loops")).json()) as { loops: LoopRecord[] };
    expect(listed.loops.map((l) => l.name)).toEqual(["weekly-review"]);
  });

  it("rejects a body with no title rather than inventing one", async () => {
    const res = await post("/api/loops", { prompt: "draft it", at: "09:00" });
    expect(res.status).toBe(400);
  });

  it("turns an engine complaint into a 400, not a 500", async () => {
    const res = await post("/api/loops", { title: "No schedule", prompt: "p" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("every") });
  });

  it("reports a duplicate as a 400", async () => {
    await post("/api/loops", { title: "Sweep", prompt: "p", every: "1h" });
    expect((await post("/api/loops", { title: "Sweep", prompt: "p", every: "1h" })).status).toBe(400);
  });

  it("edits a loop in place", async () => {
    await post("/api/loops", { title: "Sweep", prompt: "p", every: "1h" });
    const res = await patch("/api/loops/sweep", { title: "Inbox sweep" });
    expect(res.status).toBe(200);
    expect((await res.json()) as LoopRecord).toMatchObject({ name: "sweep", title: "Inbox sweep" });
  });

  it("toggles, runs and removes", async () => {
    await post("/api/loops", { title: "Sweep", prompt: "p", every: "1h" });

    expect((await (await post("/api/loops/sweep/toggle")).json()) as LoopRecord).toMatchObject({ enabled: false });
    expect((await (await post("/api/loops/sweep/run")).json())).toEqual({ sessionId: "s-sweep" });
    expect(loops.runs).toEqual(["sweep"]);

    expect((await (await post("/api/loops/sweep/remove")).json())).toEqual({ ok: true });
    expect(await (await get("/api/loops")).json()).toMatchObject({ loops: [] });
  });

  it("adopts and drops a loop on this machine, separately from the company-wide switch", async () => {
    await post("/api/loops", { title: "Sweep", prompt: "p", every: "1h" });

    const dropped = (await (await post("/api/loops/sweep/here", { active: false })).json()) as LoopRecord;
    expect(dropped).toMatchObject({ activeHere: false, enabled: true });

    const adopted = (await (await post("/api/loops/sweep/here", { active: true })).json()) as LoopRecord;
    expect(adopted).toMatchObject({ activeHere: true, enabled: true });

    // The two switches are independent: pausing for everyone leaves this machine's adoption alone.
    const paused = (await (await post("/api/loops/sweep/toggle")).json()) as LoopRecord;
    expect(paused).toMatchObject({ enabled: false, activeHere: true });
  });

  it("answers 400 for an action on a loop that does not exist", async () => {
    expect((await post("/api/loops/ghost/run")).status).toBe(400);
    expect((await post("/api/loops/ghost/toggle")).status).toBe(400);
    expect((await post("/api/loops/ghost/here", { active: true })).status).toBe(400);
    expect((await patch("/api/loops/ghost", { title: "x" })).status).toBe(400);
  });

  it("ships the spend line with the list, so one request paints the panel", async () => {
    const listed = (await (await get("/api/loops")).json()) as { spend: LoopSpendRecord };
    expect(listed.spend).toMatchObject({ today: { runs: 2, costUsd: 0.08 }, month: { costUsd: 1.6 }, overCap: false });
  });

  it("sets and clears the daily ceiling", async () => {
    expect((await (await post("/api/loops-budget", { capUsd: 5 })).json()) as LoopSpendRecord).toMatchObject({ capUsd: 5 });
    expect(loops.cap()).toBe(5);

    const cleared = (await (await post("/api/loops-budget", {})).json()) as LoopSpendRecord;
    expect(cleared.capUsd).toBeUndefined();
    expect(loops.cap()).toBeUndefined();
  });

  it("reads a zero or negative ceiling as NO ceiling, never as a limit of nothing", async () => {
    for (const capUsd of [0, -1]) {
      await post("/api/loops-budget", { capUsd: 5 });
      await post("/api/loops-budget", { capUsd });
      expect(loops.cap()).toBeUndefined();
    }
  });

  it("keeps the budget path clear of a loop that happens to be called Budget", async () => {
    await post("/api/loops", { title: "Budget", prompt: "p", every: "1h" });
    // The loop owns /api/loops/budget; the ceiling lives on its own path and is unaffected.
    expect((await (await post("/api/loops/budget/run")).json())).toEqual({ sessionId: "s-budget" });
    expect((await (await post("/api/loops-budget", { capUsd: 3 })).json()) as LoopSpendRecord).toMatchObject({ capUsd: 3 });
  });

  it("does not answer loop routes at all when no engine is wired", async () => {
    const bare = createDaemon(base());
    expect((await bare(new Request("http://127.0.0.1/api/loops"))).status).toBe(404);
  });

  it("surfaces the fields the panel renders - status, session and what a run needed a human for", async () => {
    await post("/api/loops", { title: "Mailer", prompt: "p", every: "1h" });
    loops.rows.set("mailer", {
      ...loops.rows.get("mailer")!,
      status: "needs-approval",
      sessionId: "s1",
      blockedOn: "send an email to ops@acme.com",
      lastRun: 500,
    });

    const listed = (await (await get("/api/loops")).json()) as { loops: LoopRecord[] };
    expect(listed.loops[0]).toMatchObject({
      status: "needs-approval",
      sessionId: "s1",
      blockedOn: "send an email to ops@acme.com",
      lastRun: 500,
    });
  });
});
