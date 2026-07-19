import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveOrgsRoot } from "./roots.js";

describe("resolveOrgsRoot", () => {
  it("honors an explicit BUILDEX_ORGS_ROOT above everything", () => {
    expect(resolveOrgsRoot({ env: { BUILDEX_ORGS_ROOT: "/custom/orgs", BUILDEX_DEMO_DIR: "/demo" }, appDataDir: "/app", homeDir: "/home/u" })).toBe("/custom/orgs");
  });

  it("uses <appData>/orgs when packaged", () => {
    expect(resolveOrgsRoot({ env: {}, appDataDir: "/app/BuildEx", homeDir: "/home/u" })).toBe(join("/app/BuildEx", "orgs"));
  });

  it("uses <BUILDEX_DEMO_DIR>/orgs in dev when set (rides the per-worktree demo dir)", () => {
    expect(resolveOrgsRoot({ env: { BUILDEX_DEMO_DIR: "/wt/demo" }, homeDir: "/home/u" })).toBe(join("/wt/demo", "orgs"));
  });

  it("falls back to ~/.buildex-demo/orgs with no env and no app-data", () => {
    expect(resolveOrgsRoot({ env: {}, homeDir: "/home/u" })).toBe(join("/home/u", ".buildex-demo", "orgs"));
  });
});
