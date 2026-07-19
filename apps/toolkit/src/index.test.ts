import { describe as suite, it, expect } from "vitest";
import { appName, describe } from "./index.js";

suite("@buildex/toolkit seam", () => {
  it("exposes its package identity", () => {
    expect(appName).toBe("@buildex/toolkit");
  });
  it("describes itself", () => {
    const d = describe();
    expect(d).toContain("toolkit");
    // Honest self-description: library modules today, not a shipped CLI.
    expect(d).toContain("CLI wrapper pending");
  });
});
