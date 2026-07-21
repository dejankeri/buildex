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

// Mirrors the shipped packs/core/policy/preset.json posture: wide autonomy, only irreversible
// destruction gated, nothing hard-denied, unknown tools allowed.
describe("PolicyEngine - shipped wide-by-default preset", () => {
  const shipped = new PolicyEngine({
    allow: ["Read", "Edit", "Write", "WebFetch", "WebSearch", "Bash"],
    ask: ["Bash(rm -rf:*)", "Bash(git push --force:*)", "Bash(git reset --hard:*)"],
    deny: [],
    default: "allow",
  });

  it("runs ordinary work autonomously", () => {
    expect(shipped.decide({ name: "Read", input: {} })).toBe("allow");
    expect(shipped.decide({ name: "WebSearch", input: {} })).toBe("allow");
    expect(shipped.decide({ name: "Bash", input: { command: "npm test" } })).toBe("allow");
    expect(shipped.decide({ name: "Bash", input: { command: "git push origin main" } })).toBe("allow");
  });

  it("asks only for irreversible destruction", () => {
    expect(shipped.decide({ name: "Bash", input: { command: "rm -rf build" } })).toBe("ask");
    expect(shipped.decide({ name: "Bash", input: { command: "git reset --hard HEAD~3" } })).toBe("ask");
    expect(shipped.decide({ name: "Bash", input: { command: "git push --force origin main" } })).toBe("ask");
  });

  it("allows unknown tools (MCP calls gate at the connector gateway, not here)", () => {
    expect(shipped.decide({ name: "mcp__protocolcrm__message", input: {} })).toBe("allow");
  });
});
