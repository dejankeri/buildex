import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillIntoSources } from "./backfill.js";

let base: string, src: string, team: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "buildex-backfill-"));
  src = join(base, "business");
  team = join(base, "team");
  mkdirSync(join(src, "decisions"), { recursive: true });
  mkdirSync(team, { recursive: true });
  writeFileSync(join(src, "charter.md"), "# Charter\n\nWe operate exponentially.\n");
  writeFileSync(join(src, "decisions", "log.md"), "# Decisions\n");
  writeFileSync(join(src, "logo.png"), "not markdown");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("backfillIntoSources - stage existing knowledge for agent filing", () => {
  it("copies markdown into sources/<label>/ with provenance frontmatter, preserving structure", () => {
    const res = backfillIntoSources({ sourceDir: src, teamDir: team, label: "business", at: "2026-07-16T00:00:00Z" });

    const charter = join(team, "sources", "business", "charter.md");
    expect(existsSync(charter)).toBe(true);
    const text = readFileSync(charter, "utf8");
    expect(text).toContain("source: business");
    expect(text).toContain("We operate exponentially.");
    expect(existsSync(join(team, "sources", "business", "decisions", "log.md"))).toBe(true);
    expect(res.wrote).toBe(2);
  });

  it("skips non-markdown files", () => {
    const res = backfillIntoSources({ sourceDir: src, teamDir: team, label: "business", at: "2026-07-16T00:00:00Z" });
    expect(existsSync(join(team, "sources", "business", "logo.png"))).toBe(false);
    expect(res.skipped).toContain("logo.png");
  });
});
