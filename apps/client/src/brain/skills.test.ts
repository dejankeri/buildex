import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSkill, composeSkill, readSkill, writeSkillFile, originOf } from "./skills.js";
import type { Root } from "./graph.js";

describe("validateSkill - the console's teach-a-verb quality check", () => {
  it("accepts a well-formed verb", () => {
    const good = composeSkill({
      name: "weekly-tidy",
      description: "Use when the brain has drifted and files need consolidating into the right folders.",
      instructions: "# weekly-tidy\n\n## When to use\n\n- Things are messy.\n\n## Steps\n\n1. Look.\n2. Move.",
    });
    expect(validateSkill(good)).toEqual({ ok: true, issues: [] });
  });

  it("flags a non-kebab name, a terse/non-trigger description, and a missing structure", () => {
    const bad = "---\nname: Weekly Tidy\ndescription: tidies\n---\n\nsome prose\n";
    const r = validateSkill(bad);
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/kebab/);
    expect(r.issues.join(" ")).toMatch(/trigger|terse/i);
    expect(r.issues.join(" ")).toMatch(/When to use|Steps/);
  });
});

describe("composeSkill", () => {
  it("builds frontmatter + body that round-trips through validation", () => {
    const md = composeSkill({
      name: "new-client",
      description: "Use when a new client signs so their space and kickoff are set up consistently.",
      instructions: "# new-client\n\n## Steps\n\n1. Make the folder.",
    });
    expect(md).toMatch(/^---\nname: new-client\ndescription: /);
    expect(validateSkill(md).ok).toBe(true);
  });
});

describe("skill fs surface (read/write, precedence, path-safety)", () => {
  let dir: string, roots: Root[], workspace: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "buildex-skills-"));
    workspace = join(dir, "ws");
    const core = join(dir, "core"), team = join(dir, "team");
    mkdirSync(join(core, "skills", "shared"), { recursive: true });
    writeFileSync(join(core, "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: Use when core does it.\n---\n\n# shared (core)\n");
    mkdirSync(join(team, "skills", "shared"), { recursive: true });
    writeFileSync(join(team, "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: Use when team overrides.\n---\n\n# shared (team)\n");
    // emulate generated .claude/skills links with team winning
    const dest = join(workspace, ".claude", "skills");
    mkdirSync(dest, { recursive: true });
    symlinkSync(join(team, "skills", "shared"), join(dest, "shared"), process.platform === "win32" ? "junction" : null);
    roots = [
      { name: "core", dir: core },
      { name: "team", dir: team },
    ];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("originOf reports the brain a verb came from - what the LIST carries so scope filtering is honest", () => {
    // The Brain rail's Company/Private toggle filters verbs by this; the daemon's listSkills runs
    // originOf per link, so a direct check pins the ownership resolution the whole filter rests on.
    expect(originOf(workspace, roots, "shared", join(workspace, ".claude", "skills", "shared"))).toBe("team");
  });

  it("reads a skill's full content and reports the origin repo (precedence winner)", () => {
    const s = readSkill(workspace, roots, "shared");
    expect(s.content).toContain("# shared (team)");
    expect(s.description).toBe("Use when team overrides.");
    expect(s.origin).toBe("team");
  });

  it("reports origin from the generated manifest when the skill is a plain copy (Windows fallback)", () => {
    // Emulate the copy-fallback: a real dir under .claude/skills (no symlink) + a manifest.
    // Path inference alone can't recover origin here - the bytes live inside the workspace.
    const dest = join(workspace, ".claude", "skills", "shared");
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "---\nname: shared\ndescription: Use when team overrides.\n---\n\n# shared (team)\n");
    writeFileSync(join(workspace, ".claude", "skill-origins.json"), JSON.stringify({ shared: "team" }));

    const s = readSkill(workspace, roots, "shared");
    expect(s.content).toContain("# shared (team)");
    expect(s.origin).toBe("team");
  });

  it("writes a new skill into the named repo's skills/ dir", () => {
    const content = composeSkill({ name: "cadence", description: "Use when scheduling the weekly cadence for the team.", instructions: "# cadence\n\n## Steps\n\n1. Do." });
    const { path } = writeSkillFile(roots, { name: "cadence", repo: "team", content });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("# cadence");
    expect(path).toContain(join("team", "skills", "cadence", "SKILL.md"));
  });

  it("refuses an unknown repo and a traversal-y name", () => {
    const content = composeSkill({ name: "ok-name", description: "Use when something legitimate happens here.", instructions: "# ok\n\n## Steps\n\n1. x" });
    expect(() => writeSkillFile(roots, { name: "ok-name", repo: "nope", content })).toThrow(/unknown repo/i);
    expect(() => writeSkillFile(roots, { name: "../evil", repo: "team", content })).toThrow(/name/i);
  });
});
