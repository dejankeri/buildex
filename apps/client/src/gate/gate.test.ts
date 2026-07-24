import { describe, it, expect } from "vitest";
import { Gate } from "./gate.js";
import { PolicyEngine, type PolicyPreset } from "./policy.js";
import { ApprovalBroker, type LedgerResolution } from "./approval.js";

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

// Invariant 5's record, checked at the gate: an ask-tier resolution leaves EXACTLY one activity-ledger
// entry, and routine allowed work leaves none - allow/deny resolve at policy, before any card exists.
describe("Gate.evaluate and the activity ledger", () => {
  function makeRecordingGate() {
    let n = 0;
    const recorded: LedgerResolution[] = [];
    const broker = new ApprovalBroker({
      idFactory: () => `c${++n}`,
      now: () => 0,
      ledger: { record: (e) => recorded.push(e) },
    });
    return { gate: new Gate(new PolicyEngine(preset), broker), broker, recorded };
  }

  it("an ask-tier resolution leaves exactly one ledger entry", async () => {
    const { gate, broker, recorded } = makeRecordingGate();
    const verdict = gate.evaluate({ name: "Bash", input: { command: "git push" } });
    broker.resolve(broker.pending()[0]!.id, "approve");
    expect(await verdict).toBe("allow");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ verdict: "approve", reason: "operator", tool: { name: "Bash" } });
  });

  it("an allowed tool leaves zero ledger entries - routine work is never recorded", async () => {
    const { gate, recorded } = makeRecordingGate();
    expect(await gate.evaluate({ name: "Read", input: { file_path: "team/notes.md" } })).toBe("allow");
    expect(recorded).toHaveLength(0);
  });

  it("a policy-denied tool leaves zero ledger entries - no card ever opened, no moment to record", async () => {
    const { gate, recorded } = makeRecordingGate();
    expect(await gate.evaluate({ name: "Bash", input: { command: "rm -rf /" } })).toBe("deny");
    expect(recorded).toHaveLength(0);
  });
});
