import { describe, it, expect } from "vitest";
import { delimiter, join } from "node:path";
import { augmentedPath, commonBinDirs } from "./resolve-path.js";

const HOME = "/Users/op";
// The home-relative install dir, spelled in the host's own separators (backslashes on Windows) - the
// same form the code produces via join(). Asserting against join() keeps the test cross-platform.
const localBin = join(HOME, ".local", "bin");

describe("augmentedPath", () => {
  it("prepends the common install dirs ahead of the inherited PATH", () => {
    const out = augmentedPath({ home: HOME, current: ["/usr/bin", "/bin"].join(delimiter), delimiter }).split(delimiter);
    // The dir the operator's `claude` actually lives in on the reported machine must be reachable...
    expect(out).toContain(localBin);
    expect(out).toContain("/opt/homebrew/bin");
    // ...and it must sit AHEAD of the bare inherited entries (priority preserved). "/usr/bin" is a
    // literal entry in commonBinDirs, so it is present (and de-dup keeps the earliest) on every host.
    expect(out.indexOf(localBin)).toBeLessThan(out.indexOf("/usr/bin"));
  });

  it("keeps every entry the caller already had", () => {
    const weird = "/some/custom/tool/bin";
    const out = augmentedPath({ home: HOME, current: ["/usr/bin", weird].join(delimiter), delimiter }).split(delimiter);
    expect(out).toContain(weird);
  });

  it("de-duplicates so a dir already on PATH is not repeated", () => {
    const out = augmentedPath({ home: HOME, current: ["/opt/homebrew/bin", "/usr/bin"].join(delimiter), delimiter }).split(delimiter);
    expect(out.filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("works when there is no inherited PATH at all", () => {
    const out = augmentedPath({ home: HOME, current: undefined, delimiter }).split(delimiter);
    expect(out).toEqual(commonBinDirs(HOME));
    expect(out).not.toContain(""); // no empty segments
  });
});
