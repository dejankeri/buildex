import { describe as suite, it, expect } from "vitest";
import { deriveBase, deriveWorktreeEnv } from "./worktree-env.js";

suite("deriveBase", () => {
  it("is deterministic for the same worktree root", () => {
    const a = deriveBase("/Users/x/code/buildex-Main-build", "/Users/x");
    const b = deriveBase("/Users/x/code/buildex-Main-build", "/Users/x");
    expect(a).toEqual(b);
  });
  it("keeps console even, gateway = console+1, in the 4400 band", () => {
    const e = deriveBase("/Users/x/code/buildex-Toolbar-cleanup", "/Users/x");
    expect(e.consolePort).toBeGreaterThanOrEqual(4400);
    expect(e.consolePort).toBeLessThanOrEqual(4598);
    expect(e.consolePort % 2).toBe(0);
    expect(e.gatewayPort).toBe(e.consolePort + 1);
  });
  it("puts the demo dir under ~/.buildex-demo/<basename>-<6 hex>", () => {
    const e = deriveBase("/Users/x/code/buildex", "/home/me");
    expect(e.demoDir).toMatch(/^\/home\/me\/\.buildex-demo\/buildex-[0-9a-f]{6}$/);
  });
  it("is path-sensitive: different worktrees get different demo dirs", () => {
    const a = deriveBase("/Users/x/code/wt-a", "/h");
    const b = deriveBase("/Users/x/code/wt-b", "/h");
    expect(a.demoDir).not.toBe(b.demoDir);
  });
});

suite("deriveWorktreeEnv free-port fallback", () => {
  it("returns the base pair when both ports are free", async () => {
    const base = deriveBase("/wt", "/h");
    const e = await deriveWorktreeEnv({ worktreeRoot: "/wt", homeDir: "/h", isPortFree: () => true });
    expect(e.consolePort).toBe(base.consolePort);
    expect(e.gatewayPort).toBe(base.gatewayPort);
  });
  it("steps up by 2 when the base pair is taken", async () => {
    const base = deriveBase("/wt", "/h");
    const taken = new Set([base.consolePort, base.gatewayPort]);
    const e = await deriveWorktreeEnv({ worktreeRoot: "/wt", homeDir: "/h", isPortFree: (p) => !taken.has(p) });
    expect(e.consolePort).toBe(base.consolePort + 2);
    expect(e.gatewayPort).toBe(base.consolePort + 3);
  });
  it("throws if no pair is free within maxTries", async () => {
    await expect(
      deriveWorktreeEnv({ worktreeRoot: "/wt", homeDir: "/h", isPortFree: () => false, maxTries: 3 }),
    ).rejects.toThrow(/no free/);
  });
});
