import { describe as suite, it, expect } from "vitest";
import { appName, describe } from "./index.js";

suite("@buildex/client seam", () => {
  it("exposes its package identity", () => {
    expect(appName).toBe("@buildex/client");
  });
  it("describes itself", () => {
    expect(describe()).toContain("buildex");
  });
});
