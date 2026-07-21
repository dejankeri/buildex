import { describe, it, expect } from "vitest";
import { ApprovalBroker, type ApprovalEvent, type CardOrigin } from "./approval.js";

function makeBroker() {
  let n = 0;
  let t = 1000;
  const cards: unknown[] = [];
  const broker = new ApprovalBroker({ idFactory: () => `card${++n}`, now: () => t, onCard: (c) => cards.push(c) });
  return { broker, cards, advance: (ms: number) => (t += ms) };
}

describe("ApprovalBroker", () => {
  it("creates a pending card and notifies via onCard", () => {
    const { broker, cards } = makeBroker();
    const { card } = broker.request({ name: "Bash", input: { command: "git push" } });
    expect(card).toMatchObject({ id: "card1", createdAt: 1000, tool: { name: "Bash" } });
    expect(broker.pending()).toHaveLength(1);
    expect(cards).toHaveLength(1);
  });

  it("resolves the decision promise to 'approve' and clears the card", async () => {
    const { broker } = makeBroker();
    const { card, decision } = broker.request({ name: "WebFetch", input: {} });
    broker.resolve(card.id, "approve");
    expect(await decision).toBe("approve");
    expect(broker.pending()).toHaveLength(0);
  });

  it("resolves to 'deny' when denied", async () => {
    const { broker } = makeBroker();
    const { card, decision } = broker.request({ name: "WebFetch", input: {} });
    broker.resolve(card.id, "deny");
    expect(await decision).toBe("deny");
  });

  it("returns false when resolving an unknown card and does not throw", () => {
    const { broker } = makeBroker();
    expect(broker.resolve("nope", "approve")).toBe(false);
  });

  it("tracks multiple independent pending cards", async () => {
    const { broker } = makeBroker();
    const a = broker.request({ name: "Bash", input: { command: "deploy" } });
    const b = broker.request({ name: "Bash", input: { command: "email" } });
    expect(broker.pending()).toHaveLength(2);
    broker.resolve(b.card.id, "deny");
    broker.resolve(a.card.id, "approve");
    expect(await a.decision).toBe("approve");
    expect(await b.decision).toBe("deny");
    expect(broker.pending()).toHaveLength(0);
  });
});

// A deterministic timer seam: captures armed timers so a test can fire the TTL by hand (no real
// wall-clock wait). `armed` is the count of live timers so we can assert a resolved card cleared its.
function makeTtlBroker(ttlMs: number) {
  let n = 0;
  const timers = new Map<number, () => void>();
  let seq = 0;
  const broker = new ApprovalBroker({
    idFactory: () => `card${++n}`,
    now: () => 0,
    ttlMs,
    setTimer: (fn) => {
      const h = ++seq;
      timers.set(h, fn);
      return h;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
  });
  return { broker, fireAll: () => [...timers.values()].forEach((fn) => fn()), armed: () => timers.size };
}

describe("ApprovalBroker active origin (which chat a card belongs to)", () => {
  const chat = (sessionId: string): CardOrigin => ({ kind: "chat", sessionId });

  it("stamps a card with the single active origin", () => {
    const { broker } = makeBroker();
    broker.pushOrigin(chat("s1"));
    const { card } = broker.request({ name: "Bash", input: {} });
    expect(card.origin).toEqual({ kind: "chat", sessionId: "s1" });
  });

  it("leaves origin undefined when nothing is active", () => {
    const { broker } = makeBroker();
    const { card } = broker.request({ name: "Bash", input: {} });
    expect(card.origin).toBeUndefined();
  });

  it("leaves origin undefined when two runs overlap (ambiguous → tray-only, never misrouted)", () => {
    const { broker } = makeBroker();
    const a = chat("s1");
    const b = chat("s2");
    broker.pushOrigin(a);
    broker.pushOrigin(b);
    expect(broker.request({ name: "Bash", input: {} }).card.origin).toBeUndefined();
    broker.popOrigin(b); // one run ends; the other is now unambiguous again
    expect(broker.request({ name: "Bash", input: {} }).card.origin).toEqual({ kind: "chat", sessionId: "s1" });
  });

  it("an explicit origin on request overrides the active stack", () => {
    const { broker } = makeBroker();
    broker.pushOrigin(chat("s1"));
    const { card } = broker.request({ name: "Bash", input: {} }, { kind: "automation", sessionId: "auto1" });
    expect(card.origin).toEqual({ kind: "automation", sessionId: "auto1" });
  });
});

describe("ApprovalBroker event subscription (drives the SSE push)", () => {
  it("emits open on request and resolve on resolve, and stops after unsubscribe", async () => {
    const { broker } = makeBroker();
    const events: ApprovalEvent[] = [];
    const off = broker.subscribe((ev) => events.push(ev));

    const { card, decision } = broker.request({ name: "WebFetch", input: {} });
    expect(events).toEqual([{ type: "open", card }]);

    broker.resolve(card.id, "approve");
    await decision;
    expect(events).toEqual([{ type: "open", card }, { type: "resolve", id: card.id, verdict: "approve" }]);

    off();
    broker.request({ name: "Bash", input: {} });
    expect(events).toHaveLength(2); // no further delivery after unsubscribe
  });
});

describe("ApprovalBroker TTL auto-deny", () => {
  it("auto-denies a card whose timer fires before any operator taps", async () => {
    const { broker, fireAll } = makeTtlBroker(600_000);
    const { decision } = broker.request({ name: "Bash", input: { command: "git push" } });
    expect(broker.pending()).toHaveLength(1);
    fireAll(); // operator never responded → TTL elapses
    expect(await decision).toBe("deny");
    expect(broker.pending()).toHaveLength(0);
  });

  it("clears the TTL timer when the operator resolves first (no auto-deny race)", async () => {
    const { broker, fireAll, armed } = makeTtlBroker(600_000);
    const { card, decision } = broker.request({ name: "WebFetch", input: {} });
    expect(armed()).toBe(1);
    broker.resolve(card.id, "approve");
    expect(armed()).toBe(0); // timer was cleared on resolve
    fireAll(); // firing a stale timer must be a no-op (card already gone)
    expect(await decision).toBe("approve");
  });

  it("arms no timer when ttlMs is omitted (opt-in only)", () => {
    let armed = 0;
    const broker = new ApprovalBroker({
      idFactory: () => "c1",
      now: () => 0,
      setTimer: () => (armed++, 1),
      clearTimer: () => {},
    });
    broker.request({ name: "Bash", input: {} });
    expect(armed).toBe(0);
  });
});
