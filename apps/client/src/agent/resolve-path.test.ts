import { describe, it, expect } from "vitest";
import { posix, win32 } from "node:path";
import { augmentedPath, commonBinDirs } from "./resolve-path.js";

// Both platforms are asserted explicitly rather than via the host's own separators, so every lane
// (Linux CI, macOS CI, a Windows dev box) checks the SAME two lists. The Windows branch used to be
// invisible to the suite entirely - that is how a POSIX-only dir list shipped as the Windows one.
const HOME_POSIX = "/Users/op";
const HOME_WIN = "C:\\Users\\op";

describe("augmentedPath - macOS/Linux", () => {
  const opts = { home: HOME_POSIX, platform: "darwin", delimiter: ":" };
  const localBin = posix.join(HOME_POSIX, ".local", "bin");

  it("prepends the common install dirs ahead of the inherited PATH", () => {
    const out = augmentedPath({ ...opts, current: "/usr/bin:/bin" }).split(":");
    // The dir the operator's `claude` actually lives in on the reported machine must be reachable...
    expect(out).toContain(localBin);
    expect(out).toContain("/opt/homebrew/bin");
    // ...and it must sit AHEAD of the bare inherited entries (priority preserved).
    expect(out.indexOf(localBin)).toBeLessThan(out.indexOf("/usr/bin"));
  });

  it("keeps every entry the caller already had", () => {
    const weird = "/some/custom/tool/bin";
    const out = augmentedPath({ ...opts, current: `/usr/bin:${weird}` }).split(":");
    expect(out).toContain(weird);
  });

  it("de-duplicates so a dir already on PATH is not repeated", () => {
    const out = augmentedPath({ ...opts, current: "/opt/homebrew/bin:/usr/bin" }).split(":");
    expect(out.filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("works when there is no inherited PATH at all", () => {
    const out = augmentedPath({ ...opts, current: undefined }).split(":");
    expect(out).toEqual(commonBinDirs(HOME_POSIX, "darwin"));
    expect(out).not.toContain(""); // no empty segments
  });
});

describe("augmentedPath - Windows", () => {
  const opts = { home: HOME_WIN, platform: "win32" as const };
  const npmGlobal = win32.join(HOME_WIN, "AppData", "Roaming", "npm");

  it("includes npm's global bin, where `npm i -g` writes claude.cmd", () => {
    // The concrete gap: without this the packaged Windows app widened PATH with 14 POSIX dirs that
    // cannot exist, and still could not see an npm-global agent CLI.
    expect(commonBinDirs(HOME_WIN, "win32")).toContain(npmGlobal);
  });

  it("offers no POSIX-only directory, which could never exist on Windows", () => {
    const dirs = commonBinDirs(HOME_WIN, "win32");
    for (const posixOnly of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
      expect(dirs).not.toContain(posixOnly);
    }
    // Assert the absence of POSIX absolutes, NOT the presence of a drive letter: a Windows home can
    // legitimately be a UNC path (`\\fileserver\home\ivan`) on a domain-joined machine, and every
    // dir here is derived from `home`, so it inherits whatever form that takes.
    expect(dirs.every((d) => !d.startsWith("/"))).toBe(true);
  });

  it("splits and rejoins an inherited Windows PATH on ';' without shredding drive letters", () => {
    // Splitting a Windows PATH on ':' would cut every "C:\..." entry in half - the reason the
    // delimiter is derived from the platform rather than the host.
    const current = "C:\\Windows\\System32;C:\\Program Files\\nodejs";
    const out = augmentedPath({ ...opts, current }).split(";");
    expect(out).toContain("C:\\Windows\\System32");
    expect(out).toContain("C:\\Program Files\\nodejs");
    expect(out.indexOf(npmGlobal)).toBeLessThan(out.indexOf("C:\\Windows\\System32"));
  });

  it("de-duplicates against an inherited entry that is already a common dir", () => {
    const out = augmentedPath({ ...opts, current: npmGlobal }).split(";");
    expect(out.filter((d) => d === npmGlobal)).toHaveLength(1);
  });
});
