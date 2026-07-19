import { describe, it, expect, vi } from "vitest";
import { drainOnce, type DrainSource } from "./automation-drain.js";

function source(due: { id: string; verb: string }[], claimable = new Set(due.map((d) => d.id))): DrainSource & { reported: Record<string, string> } {
  const reported: Record<string, string> = {};
  return {
    reported,
    listDue: async () => due,
    claim: async (id) => (claimable.has(id) ? due.find((d) => d.id === id) ?? null : null),
    report: async (id, r) => { reported[id] = r.state; },
  };
}

describe("drainOnce", () => {
  it("claims each due run, runs the verb, reports done", async () => {
    const src = source([{ id: "r1", verb: "daily-digest" }]);
    const ran: string[] = [];
    const out = await drainOnce({
      source: src,
      running: new Set(),
      runVerb: async (verb) => { ran.push(verb); return { sessionId: "s-" + verb }; },
    });
    expect(out.ran).toEqual(["r1"]);
    expect(ran).toEqual(["daily-digest"]);
    expect(src.reported["r1"]).toBe("done");
  });

  it("skips a run it cannot claim (another machine won)", async () => {
    const src = source([{ id: "r1", verb: "v" }], new Set()); // nothing claimable
    const out = await drainOnce({ source: src, running: new Set(), runVerb: async () => ({ sessionId: "x" }) });
    expect(out.ran).toEqual([]);
    expect(src.reported["r1"]).toBeUndefined();
  });

  it("reports failed when the verb throws", async () => {
    const src = source([{ id: "r1", verb: "boom" }]);
    const out = await drainOnce({
      source: src,
      running: new Set(),
      runVerb: async () => { throw new Error("kaboom"); },
    });
    expect(out.ran).toEqual([]);
    expect(src.reported["r1"]).toBe("failed");
  });

  it("does not run a verb already in-flight", async () => {
    const src = source([{ id: "r1", verb: "dup" }]);
    const running = new Set<string>(["dup"]);
    let calls = 0;
    await drainOnce({ source: src, running, runVerb: async () => { calls++; return { sessionId: "s" }; } });
    expect(calls).toBe(0);
  });

  it("heartbeats a claimed run while it executes, and stops once it's done", async () => {
    vi.useFakeTimers();
    try {
      const heartbeats: string[] = [];
      const src: DrainSource & { reported: Record<string, string> } = {
        reported: {},
        listDue: async () => [{ id: "r1", verb: "slow" }],
        claim: async (id) => (id === "r1" ? { id: "r1", verb: "slow" } : null),
        report: async (id, r) => { src.reported[id] = r.state; },
        heartbeat: async (id) => { heartbeats.push(id); },
      };
      // The verb resolves only once time has been advanced past several heartbeat intervals.
      let resolveVerb!: () => void;
      const verbDone = new Promise<void>((resolve) => { resolveVerb = resolve; });
      const runVerb = async (): Promise<{ sessionId: string }> => {
        await verbDone;
        return { sessionId: "s-slow" };
      };

      const donePromise = drainOnce({ source: src, running: new Set(), runVerb, heartbeatMs: 10 });
      // Let several heartbeat intervals fire while the verb is still in flight.
      await vi.advanceTimersByTimeAsync(45);
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);

      const countAtFinish = heartbeats.length;
      resolveVerb();
      await donePromise;
      expect(src.reported["r1"]).toBe("done");

      // The interval must be cleared on completion - advancing further must not add more calls.
      await vi.advanceTimersByTimeAsync(45);
      expect(heartbeats.length).toBe(countAtFinish);
    } finally {
      vi.useRealTimers();
    }
  });
});
