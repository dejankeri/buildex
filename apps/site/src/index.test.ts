import { describe as suite, it, expect } from "vitest";
import { appName, describe } from "./index.js";

suite("@buildex/site seam", () => {
  it("exposes its package identity", () => {
    expect(appName).toBe("@buildex/site");
  });
  it("describes itself", () => {
    expect(describe()).toContain("BuildEx");
  });
});
