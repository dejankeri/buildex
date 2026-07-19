import { describe, it, expect } from "vitest";
import { PolicyEngine, type PolicyPreset } from "./policy.js";

const preset: PolicyPreset = {
  allow: ["Read", "Edit", "Write", "Bash(git status:*)"],
  ask: ["Bash", "WebFetch"],
  deny: ["Bash(rm:*)"],
  default: "ask",
};
const engine = new PolicyEngine(preset);

describe("PolicyEngine.decide", () => {
  it("allows reads and local edits", () => {
    expect(engine.decide({ name: "Read", input: {} })).toBe("allow");
    expect(engine.decide({ name: "Edit", input: {} })).toBe("allow");
    expect(engine.decide({ name: "Write", input: {} })).toBe("allow");
  });

  it("asks for outward/irreversible tools", () => {
    expect(engine.decide({ name: "WebFetch", input: {} })).toBe("ask");
    expect(engine.decide({ name: "Bash", input: { command: "curl example.com" } })).toBe("ask");
  });

  it("denies an explicitly dangerous command regardless of the broader ask rule", () => {
    expect(engine.decide({ name: "Bash", input: { command: "rm -rf /" } })).toBe("deny");
  });

  it("prefers a more specific allow rule over a broader ask rule", () => {
    // `Bash(git status:*)` is allow; `Bash` is ask - the specific rule wins.
    expect(engine.decide({ name: "Bash", input: { command: "git status --short" } })).toBe("allow");
  });

  it("falls back to the default for an unknown tool", () => {
    expect(engine.decide({ name: "SomeMcpTool", input: {} })).toBe("ask");
  });
});
