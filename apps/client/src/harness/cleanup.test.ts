import { describe, it, expect } from "vitest";
import { CleanupRegistry } from "./cleanup.js";

describe("CleanupRegistry - interrupt-safe teardown (SIGINT + normal completion)", () => {
  it("runs registered cleanups in LIFO order", async () => {
    const order: string[] = [];
    const registry = new CleanupRegistry();
    registry.push("first", () => {
      order.push("first");
    });
    registry.push("second", () => {
      order.push("second");
    });
    registry.push("third", () => {
      order.push("third");
    });
    const failed = await registry.runAll();
    expect(order).toEqual(["third", "second", "first"]);
    expect(failed).toEqual([]);
  });

  it("awaits async cleanups before resolving", async () => {
    let finished = false;
    const registry = new CleanupRegistry();
    registry.push("slow", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      finished = true;
    });
    await registry.runAll();
    expect(finished).toBe(true);
  });

  it("runs each registered fn at most once, even across repeated runAll calls", async () => {
    let calls = 0;
    const registry = new CleanupRegistry();
    registry.push("once", () => {
      calls++;
    });
    const first = await registry.runAll();
    const second = await registry.runAll();
    expect(calls).toBe(1);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });

  it("catches a throwing cleanup, logs it, and still runs the rest (LIFO order preserved)", async () => {
    const order: string[] = [];
    const logs: string[] = [];
    const registry = new CleanupRegistry();
    registry.push("ok-before", () => {
      order.push("ok-before");
    });
    registry.push("boom", () => {
      throw new Error("kaboom");
    });
    registry.push("ok-after", () => {
      order.push("ok-after");
    });
    const failed = await registry.runAll((line) => logs.push(line));
    expect(order).toEqual(["ok-after", "ok-before"]);
    expect(logs).toEqual(["cleanup 'boom' failed: kaboom"]);
    expect(failed).toEqual(["boom"]);
  });

  it("catches an async cleanup that rejects", async () => {
    const logs: string[] = [];
    const registry = new CleanupRegistry();
    registry.push("async-boom", async () => {
      throw new Error("async kaboom");
    });
    const failed = await registry.runAll((line) => logs.push(line));
    expect(logs).toEqual(["cleanup 'async-boom' failed: async kaboom"]);
    expect(failed).toEqual(["async-boom"]);
  });

  it("stringifies a non-Error throw", async () => {
    const logs: string[] = [];
    const registry = new CleanupRegistry();
    registry.push("stringy", () => {
      throw "plain string";
    });
    const failed = await registry.runAll((line) => logs.push(line));
    expect(logs).toEqual(["cleanup 'stringy' failed: plain string"]);
    expect(failed).toEqual(["stringy"]);
  });

  it("never rethrows - runAll resolves even without a log callback", async () => {
    const registry = new CleanupRegistry();
    registry.push("boom", () => {
      throw new Error("kaboom");
    });
    await expect(registry.runAll()).resolves.toEqual(["boom"]);
  });

  it("does not retry a failed cleanup on a second runAll", async () => {
    let calls = 0;
    const logs: string[] = [];
    const registry = new CleanupRegistry();
    registry.push("boom", () => {
      calls++;
      throw new Error("kaboom");
    });
    const first = await registry.runAll((line) => logs.push(line));
    const second = await registry.runAll((line) => logs.push(line));
    expect(calls).toBe(1);
    expect(logs).toEqual(["cleanup 'boom' failed: kaboom"]);
    expect(first).toEqual(["boom"]);
    expect(second).toEqual([]);
  });

  it("a second runAll with nothing left to run calls the log for nothing and resolves", async () => {
    const logs: string[] = [];
    const registry = new CleanupRegistry();
    registry.push("once", () => {});
    const first = await registry.runAll((line) => logs.push(line));
    const second = await registry.runAll((line) => logs.push(line));
    expect(logs).toEqual([]);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });

  it("entries pushed while runAll() is in flight are deferred to the next runAll() call", async () => {
    const order: string[] = [];
    const registry = new CleanupRegistry();
    registry.push("initial", () => {
      order.push("initial");
      registry.push("pushed-during-flight", () => {
        order.push("pushed-during-flight");
      });
    });
    // First runAll: only "initial" runs; "pushed-during-flight" is not yet seen
    await registry.runAll();
    expect(order).toEqual(["initial"]);
    // Second runAll: only "pushed-during-flight" runs (it was deferred from the first pass)
    await registry.runAll();
    expect(order).toEqual(["initial", "pushed-during-flight"]);
  });
});
