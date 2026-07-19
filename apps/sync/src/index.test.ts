import { describe as suite, it, expect } from "vitest";
import { appName, describe } from "./index.js";

suite("@buildex/sync seam", () => {
  it("exposes its package identity", () => {
    expect(appName).toBe("@buildex/sync");
  });
  it("describes itself", () => {
    expect(describe()).toContain("buildex");
  });
});
