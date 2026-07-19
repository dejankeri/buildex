// INVARIANT REGISTRY [release-gate:registry] (release-gate meta-check): the claim "five release-gate
// suites, cannot be skipped" is only true if the five are actually present and named.
// This scans every test file in the monorepo for `[release-gate:<name>]` describe tags and asserts
// the tagged set is EXACTLY the five known invariants. Remove or rename a tag and this fails; add a
// sixth invariant and this fails until the registry + `task invariants` are updated to match. That is
// what makes the gate self-verifying rather than a claim in a doc.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The five release-gate invariant suites. Keep in sync with `task invariants`.
const EXPECTED = ["determinism", "gates", "permission-matrix", "secrets", "sync-safety"];

// Build the marker prefix from parts so this file's own source never contains a self-matching literal.
const MARKER = new RegExp("\\[" + "release-gate:" + "([a-z-]+)\\]", "g");

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("INVARIANT REGISTRY [release-gate:registry]: exactly the five release-gate suites are tagged", () => {
  it("every expected invariant has a tagged suite, and there are no unknown ones", () => {
    // vitest runs this from the app dir (apps/client); the monorepo root is two levels up.
    const appsDir = join(process.cwd(), "..", "..", "apps");
    const found = new Set<string>();
    for (const f of testFiles(appsDir)) {
      for (const m of readFileSync(f, "utf8").matchAll(MARKER)) found.add(m[1]!);
    }
    found.delete("registry"); // this meta-suite itself is not one of the five
    expect([...found].sort()).toEqual([...EXPECTED].sort());
  });
});
