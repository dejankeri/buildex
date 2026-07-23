import { describe, it, expect } from "vitest";
import { redactText } from "./redact.js";

describe("redactText", () => {
  it("replaces every occurrence of a secret with [REDACTED]", () => {
    const out = redactText("key=pk_super_secret_1 again pk_super_secret_1", ["pk_super_secret_1"]);
    expect(out).toBe("key=[REDACTED] again [REDACTED]");
  });

  it("scrubs multiple distinct secrets in one pass", () => {
    const out = redactText("a=alpha b=beta", ["alpha", "beta"]);
    expect(out).toBe("a=[REDACTED] b=[REDACTED]");
  });

  it("ignores empty secret entries and leaves unmatched text untouched", () => {
    const out = redactText("nothing to scrub here", ["", "not-present"]);
    expect(out).toBe("nothing to scrub here");
  });
});
