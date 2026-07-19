import { describe as suite, it, expect } from "vitest";
import { appName, describe } from "./index.js";

suite("@buildex/connectors seam", () => {
  it("exposes its package identity", () => {
    expect(appName).toBe("@buildex/connectors");
  });
  it("describes itself", () => {
    expect(describe()).toContain("buildex");
  });
});
