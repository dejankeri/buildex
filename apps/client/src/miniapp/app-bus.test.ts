import { describe, it, expect } from "vitest";
import { AppBus } from "./app-bus.js";

function makeBus() {
  let n = 0;
  return new AppBus({ idFactory: () => `f${++n}` });
}

describe("AppBus - the agent↔mini-app bridge", () => {
  it("fast-fails a command when no mini-app window is open", async () => {
    const bus = makeBus();
    await expect(bus.send({ app: "dashboard", op: "click", selector: "#go" })).rejects.toThrow(/no mini-app/i);
  });

  it("relays a command to the window and resolves with its result", async () => {
    const bus = makeBus();
    const unsub = bus.subscribe();
    const p = bus.send({ app: "dashboard", op: "read", selector: "[data-metric]" });

    // the browser side drains the queued frame and reports a result
    const frames = bus.drain();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: "f1", command: { app: "dashboard", op: "read" } });
    expect(bus.resolve("f1", { ok: true, result: "1,200" })).toBe(true);

    expect(await p).toEqual({ ok: true, result: "1,200" });
    unsub();
  });

  it("drains each frame only once", async () => {
    const bus = makeBus();
    bus.subscribe();
    void bus.send({ app: "d", op: "click", selector: "#x" });
    expect(bus.drain()).toHaveLength(1);
    expect(bus.drain()).toHaveLength(0);
  });

  it("returns false when resolving an unknown command id", () => {
    const bus = makeBus();
    bus.subscribe();
    expect(bus.resolve("nope", { ok: true })).toBe(false);
  });

  it("propagates a command error result", async () => {
    const bus = makeBus();
    bus.subscribe();
    const p = bus.send({ app: "d", op: "fill", selector: "#missing", value: "x" });
    bus.drain();
    bus.resolve("f1", { ok: false, error: "selector not found" });
    await expect(p).resolves.toEqual({ ok: false, error: "selector not found" });
  });
});
