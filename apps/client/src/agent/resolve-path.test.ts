import { describe, it, expect } from "vitest";
import { augmentedPath, commonBinDirs } from "./resolve-path.js";

const HOME = "/Users/op";

describe("augmentedPath", () => {
  it("prepends the common install dirs ahead of the inherited PATH", () => {
    const out = augmentedPath({ home: HOME, current: "/usr/bin:/bin", delimiter: ":" }).split(":");
    // The dir the operator's `claude` actually lives in on the reported machine must be reachable...
    expect(out).toContain("/Users/op/.local/bin");
    expect(out).toContain("/opt/homebrew/bin");
    // ...and it must sit AHEAD of the bare inherited entries (priority preserved).
    expect(out.indexOf("/Users/op/.local/bin")).toBeLessThan(out.indexOf("/usr/bin"));
  });

  it("keeps every entry the caller already had", () => {
    const weird = "/some/custom/tool/bin";
    const out = augmentedPath({ home: HOME, current: `/usr/bin:${weird}`, delimiter: ":" }).split(":");
    expect(out).toContain(weird);
  });

  it("de-duplicates so a dir already on PATH is not repeated", () => {
    const out = augmentedPath({ home: HOME, current: "/opt/homebrew/bin:/usr/bin", delimiter: ":" }).split(":");
    expect(out.filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("works when there is no inherited PATH at all", () => {
    const out = augmentedPath({ home: HOME, current: undefined, delimiter: ":" }).split(":");
    expect(out).toEqual(commonBinDirs(HOME));
    expect(out).not.toContain(""); // no empty segments
  });
});
