import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validateVerb } from "./promotion-checklist.js";

// apps/toolkit/src → repo root → packs/core
const CORE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packs", "core");

describe("packs/core - every shipped verb passes the promotion checklist", () => {
  const skillsDir = join(CORE, "skills");
  const verbs = readdirSync(skillsDir).filter((n) => existsSync(join(skillsDir, n, "SKILL.md")));

  it("ships the v1 verb set", () => {
    expect(verbs.sort()).toEqual(
      ["capture-decision", "content-draft", "map-update", "new-client", "tidy", "weekly-review"].sort(),
    );
  });

  for (const verb of verbs) {
    it(`verb "${verb}" passes the checklist`, () => {
      const res = validateVerb(readFileSync(join(skillsDir, verb, "SKILL.md"), "utf8"));
      expect(res.issues).toEqual([]);
      expect(res.ok).toBe(true);
    });
  }
});

describe("packs/core - the policy preset is well-formed", () => {
  it("has allow/ask/deny lists and a default decision", () => {
    const preset = JSON.parse(readFileSync(join(CORE, "policy", "preset.json"), "utf8"));
    expect(Array.isArray(preset.allow)).toBe(true);
    expect(preset.allow).toContain("Read");
    expect(preset.ask).toContain("Bash");
    expect(preset.deny).toContain("Bash(rm:*)");
    expect(["allow", "ask", "deny"]).toContain(preset.default);
  });
});
