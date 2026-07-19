import { describe, it, expect } from "vitest";
import { Gate } from "./gate.js";
import { PolicyEngine, type PolicyPreset } from "./policy.js";
import { ApprovalBroker } from "./approval.js";

const preset: PolicyPreset = {
  allow: ["Read", "Edit"],
  ask: ["Bash", "WebFetch"],
  deny: ["Bash(rm:*)"],
  default: "ask",
};

function makeGate() {
  let n = 0;
  const broker = new ApprovalBroker({ idFactory: () => `c${++n}`, now: () => 0 });
  const gate = new Gate(new PolicyEngine(preset), broker);
  return { gate, broker };
}

describe("Gate.evaluate", () => {
  it("allows an allow-tier tool with no approval card", async () => {
    const { gate, broker } = makeGate();
    expect(await gate.evaluate({ name: "Read", input: {} })).toBe("allow");
    expect(broker.pending()).toHaveLength(0);
  });

  it("denies a deny-tier tool with no approval card", async () => {
    const { gate, broker } = makeGate();
    expect(await gate.evaluate({ name: "Bash", input: { command: "rm -rf /" } })).toBe("deny");
    expect(broker.pending()).toHaveLength(0);
  });

  it("routes an ask-tier tool through an approval card - approve → allow", async () => {
    const { gate, broker } = makeGate();
    const verdict = gate.evaluate({ name: "Bash", input: { command: "git push" } });
    // a card is now pending; the operator approves it
    expect(broker.pending()).toHaveLength(1);
    broker.resolve(broker.pending()[0]!.id, "approve");
    expect(await verdict).toBe("allow");
  });

  it("routes an ask-tier tool - deny → deny", async () => {
    const { gate, broker } = makeGate();
    const verdict = gate.evaluate({ name: "WebFetch", input: {} });
    broker.resolve(broker.pending()[0]!.id, "deny");
    expect(await verdict).toBe("deny");
  });
});
