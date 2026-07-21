import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedGit, GIT_LINE_ENDING_PIN } from "./git-pin.js";
import { toPosix } from "./to-posix.js";

describe("pinnedGit", () => {
  it("prefixes the line-ending pin ahead of the caller's own arguments", () => {
    expect(pinnedGit(["status", "--porcelain"])).toEqual([
      "-c", "core.autocrlf=false",
      "-c", "core.eol=lf",
      "status", "--porcelain",
    ]);
  });

  it("keeps the pin before the subcommand, where git requires config options to sit", () => {
    // `git status -c foo=bar` is not the same thing: -c is a git-level option, not a subcommand one.
    const args = pinnedGit(["commit", "-m", "msg"]);
    expect(args.indexOf("commit")).toBeGreaterThan(args.lastIndexOf("core.eol=lf"));
  });

  it("passes an empty arg list through as just the pin", () => {
    expect(pinnedGit([])).toEqual([...GIT_LINE_ENDING_PIN]);
  });
});

describe("toPosix", () => {
  it("normalizes Windows separators so map keys and tool events agree", () => {
    expect(toPosix("team\\notes\\plan.md")).toBe("team/notes/plan.md");
  });

  it("leaves an already-POSIX path untouched", () => {
    expect(toPosix("team/notes/plan.md")).toBe("team/notes/plan.md");
  });

  it("is idempotent", () => {
    expect(toPosix(toPosix("a\\b\\c.md"))).toBe("a/b/c.md");
  });
});

describe("no second copy of either definition survives", () => {
  // The point of both helpers is that there is exactly ONE of each: the reviewer's concern was that
  // the coupling between graph.ts and parser.ts was by copy, so changing one would silently desync
  // tool events from the live map. A grep-level assertion is crude, but it is what actually fails if
  // someone re-inlines a copy.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = (p: string) => readFileSync(join(here, "..", p), "utf8");

  it("graph.ts and parser.ts both import toPosix rather than re-declaring it", () => {
    for (const f of ["brain/graph.ts", "agent/parser.ts"]) {
      const s = src(f);
      expect(s, f).toContain("to-posix.js");
      expect(s, f).not.toMatch(/function toPosix\s*\(/);
      expect(s, f).not.toMatch(/\.split\("\\\\"\)\.join\("\/"\)/); // the re-inlined one-liner
    }
  });

  it("every git-invoking trust surface routes through pinnedGit", () => {
    // invariant 9 (the map) and invariant 8 (the engine) must agree about the same repo's dirtiness;
    // an unpinned call on a CRLF working tree is exactly how they would diverge.
    for (const f of ["sync/engine.ts", "brain/graph.ts", "provision/core-pack.ts"]) {
      expect(src(f), f).toContain("pinnedGit");
    }
  });
});
