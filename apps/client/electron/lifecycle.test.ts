import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { win32, posix, join as hostJoin } from "node:path";

// main.cjs is CommonJS Electron plumbing; the two decisions that are not plumbing - which userData
// dir this launch owns, and how a daemon is stopped on each platform - are extracted here so they can
// be unit-tested without standing up Electron. Same pattern as external-url.cjs.
const require = createRequire(import.meta.url);
const { scopedUserDataDir } = require("./user-data.cjs") as {
  scopedUserDataDir: (env: Record<string, string | undefined>) => string | null;
};
const { killProcessTree } = require("./kill-tree.cjs") as {
  killProcessTree: (
    child: { pid?: number; kill?: () => void } | null,
    deps: { platform: string; spawnSync: (f: string, a: string[], o: unknown) => { status: number } },
  ) => void;
};

describe("scopedUserDataDir - one lock per worktree, not one for the whole machine", () => {
  it("scopes userData inside the per-worktree demo dir when BUILDEX_DEMO_DIR is set", () => {
    const demoDir = win32.join("C:\\Users\\op\\.buildex-demo", "buildex-a1b2c3");
    const got = scopedUserDataDir({ BUILDEX_DEMO_DIR: demoDir });
    expect(got).not.toBeNull();
    expect(got!.startsWith(demoDir)).toBe(true);
  });

  it("gives two worktrees DIFFERENT dirs, so the second instance is not refused the lock", () => {
    // The regression: app.setName("BuildEx") made these identical, so worktree B quit on launch and
    // focused worktree A's window - on macOS exactly as on Windows.
    const a = scopedUserDataDir({ BUILDEX_DEMO_DIR: posix.join("/Users/op/.buildex-demo", "buildex-a1b2c3") });
    const b = scopedUserDataDir({ BUILDEX_DEMO_DIR: posix.join("/Users/op/.buildex-demo", "buildex-d4e5f6") });
    expect(a).not.toBe(b);
  });

  it("is stable for the same worktree across launches", () => {
    const env = { BUILDEX_DEMO_DIR: posix.join("/Users/op/.buildex-demo", "buildex-a1b2c3") };
    expect(scopedUserDataDir(env)).toBe(scopedUserDataDir(env));
  });

  it("stays inside the demo dir, so `rm -rf <demoDir>` also clears the lock", () => {
    // CLAUDE.md documents resetting one worktree that way; a lock living elsewhere would survive it.
    // Built with the HOST's separators, because the module joins with the host's path module - the
    // dir is only ever consumed on the machine that produced it.
    const demoDir = hostJoin("demo-root", ".buildex-demo", "buildex-a1b2c3");
    expect(scopedUserDataDir({ BUILDEX_DEMO_DIR: demoDir })!.startsWith(demoDir)).toBe(true);
  });

  it("keeps Electron's default (and the GLOBAL lock) for a packaged launch", () => {
    // The global lock exists for the installer's post-install launch racing a manual one - a packaged
    // app sets no BUILDEX_DEMO_DIR and must keep it.
    expect(scopedUserDataDir({})).toBeNull();
    expect(scopedUserDataDir({ BUILDEX_DEMO_DIR: "" })).toBeNull();
    expect(scopedUserDataDir({ BUILDEX_DEMO_DIR: "   " })).toBeNull();
  });
});

describe("killProcessTree - stopping the daemon without orphaning it", () => {
  function spy(status = 0) {
    const calls: { file: string; args: string[] }[] = [];
    return {
      calls,
      spawnSync: (file: string, args: string[]) => {
        calls.push({ file, args });
        return { status };
      },
    };
  }

  it("on win32 fells the whole tree with taskkill /T /F", () => {
    const s = spy();
    let killed = false;
    killProcessTree({ pid: 4242, kill: () => (killed = true) }, { platform: "win32", spawnSync: s.spawnSync });
    expect(s.calls[0]!.file).toBe("taskkill");
    expect(s.calls[0]!.args).toEqual(["/pid", "4242", "/T", "/F"]);
    // Must NOT also call kill(): killing cmd.exe first removes the pid /T needs to walk the tree,
    // after which taskkill reports "process not found" and the grandchildren survive.
    expect(killed).toBe(false);
  });

  it("falls back to kill() when taskkill is unavailable or fails (never worse)", () => {
    const s = spy(1);
    let killed = false;
    killProcessTree({ pid: 4242, kill: () => (killed = true) }, { platform: "win32", spawnSync: s.spawnSync });
    expect(killed).toBe(true);
  });

  it("on macOS and Linux uses kill() and never shells out to taskkill", () => {
    for (const platform of ["darwin", "linux"]) {
      const s = spy();
      let killed = false;
      killProcessTree({ pid: 4242, kill: () => (killed = true) }, { platform, spawnSync: s.spawnSync });
      expect(s.calls, platform).toEqual([]);
      expect(killed, platform).toBe(true);
    }
  });

  it("does nothing rather than throwing when there is no pid or no child", () => {
    const s = spy();
    expect(() => killProcessTree(null, { platform: "win32", spawnSync: s.spawnSync })).not.toThrow();
    expect(() => killProcessTree({}, { platform: "win32", spawnSync: s.spawnSync })).not.toThrow();
    expect(s.calls).toEqual([]);
  });
});
