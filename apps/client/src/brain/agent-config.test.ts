import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readlinkSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentConfig, defaultLinkStrategy, type Root } from "./agent-config.js";
import type { PolicyPreset } from "../gate/policy.js";

let base: string;
let ws: string;
let roots: Root[];

const preset: PolicyPreset = { allow: ["Read", "Edit"], ask: ["Bash", "WebFetch"], deny: ["Bash(rm:*)"], default: "ask" };

function seedRoot(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writeFile(dir: string, rel: string, content: string) {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "buildex-cfg-"));
  ws = join(base, "ws");
  mkdirSync(ws, { recursive: true });
  const core = seedRoot("core");
  const team = seedRoot("team");
  const priv = seedRoot("private");
  roots = [
    { name: "core", dir: core },
    { name: "team", dir: team },
    { name: "private", dir: priv },
  ];
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("generateAgentConfig - rules assembly", () => {
  it("assembles CLAUDE.md from core → team → private in order", () => {
    writeFile(roots[0]!.dir, "CLAUDE.md", "CORE RULES\n");
    writeFile(roots[1]!.dir, "CLAUDE.md", "TEAM RULES\n");
    writeFile(roots[2]!.dir, "CLAUDE.md", "PRIVATE RULES\n");
    generateAgentConfig({ workspace: ws, roots, preset, gateCommand: "buildex-gate" });

    const md = readFileSync(join(ws, "CLAUDE.md"), "utf8");
    expect(md.indexOf("CORE RULES")).toBeLessThan(md.indexOf("TEAM RULES"));
    expect(md.indexOf("TEAM RULES")).toBeLessThan(md.indexOf("PRIVATE RULES"));
  });
});

describe("generateAgentConfig - skill links with precedence private > team > core", () => {
  it("links each skill; a private/team skill overrides a core skill of the same name", () => {
    writeFile(roots[0]!.dir, "skills/tidy/SKILL.md", "core tidy\n");
    writeFile(roots[1]!.dir, "skills/tidy/SKILL.md", "team tidy\n"); // overrides core
    writeFile(roots[2]!.dir, "skills/mine/SKILL.md", "private mine\n");
    generateAgentConfig({ workspace: ws, roots, preset, gateCommand: "buildex-gate" });

    // tidy resolves to team's copy (team overrides core; no private tidy)
    const tidyLink = readlinkSync(join(ws, ".claude", "skills", "tidy"));
    expect(tidyLink).toContain(join("team", "skills", "tidy"));
    // mine resolves to private
    expect(existsSync(join(ws, ".claude", "skills", "mine"))).toBe(true);
    expect(readFileSync(join(ws, ".claude", "skills", "mine", "SKILL.md"), "utf8")).toContain("private mine");
  });
});

describe("defaultLinkStrategy - platform selection", () => {
  it("uses junctions on Windows (no elevation needed) and symlinks elsewhere", () => {
    expect(defaultLinkStrategy("win32")).toBe("junction");
    expect(defaultLinkStrategy("darwin")).toBe("symlink");
    expect(defaultLinkStrategy("linux")).toBe("symlink");
  });
});

describe("generateAgentConfig - copy strategy (Windows cross-volume fallback)", () => {
  it("materializes real skill directories (not symlinks) with precedence preserved", () => {
    writeFile(roots[0]!.dir, "skills/tidy/SKILL.md", "core tidy\n");
    writeFile(roots[1]!.dir, "skills/tidy/SKILL.md", "team tidy\n"); // overrides core
    generateAgentConfig({ workspace: ws, roots, preset, gateCommand: "g", linkStrategy: "copy" });

    const tidy = join(ws, ".claude", "skills", "tidy");
    expect(lstatSync(tidy).isSymbolicLink()).toBe(false); // a real dir, not a link
    expect(readFileSync(join(tidy, "SKILL.md"), "utf8")).toContain("team tidy"); // precedence held
  });

  it("records a skill-origins manifest mapping each verb to its winning repo", () => {
    writeFile(roots[0]!.dir, "skills/tidy/SKILL.md", "core tidy\n");
    writeFile(roots[1]!.dir, "skills/tidy/SKILL.md", "team tidy\n");
    writeFile(roots[2]!.dir, "skills/mine/SKILL.md", "private mine\n");
    generateAgentConfig({ workspace: ws, roots, preset, gateCommand: "g", linkStrategy: "copy" });

    const origins = JSON.parse(readFileSync(join(ws, ".claude", "skill-origins.json"), "utf8"));
    expect(origins).toEqual({ mine: "private", tidy: "team" });
  });
});

describe("generateAgentConfig - settings.json (policy preset + gate hook)", () => {
  it("writes the allow/ask/deny permissions and a PreToolUse hook", () => {
    generateAgentConfig({ workspace: ws, roots, preset, gateCommand: "buildex-gate --port 7777" });
    const settings = JSON.parse(readFileSync(join(ws, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.ask).toContain("Bash");
    expect(settings.permissions.deny).toContain("Bash(rm:*)");
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toContain("buildex-gate");
    // A timeout must be present and above the card TTL, so a stalled approval auto-denies cleanly
    // rather than timing the hook out (a hook timeout is non-blocking → the tool would proceed).
    expect(hook.timeout).toBeGreaterThan(600);
  });

  it("omits the hook (permissions only) when no gateCommand is given", () => {
    generateAgentConfig({ workspace: ws, roots, preset });
    const settings = JSON.parse(readFileSync(join(ws, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks).toBeUndefined();
  });
});

describe("generateAgentConfig - determinism", () => {
  it("regenerates byte-identically (safe to run on every sync)", () => {
    writeFile(roots[0]!.dir, "CLAUDE.md", "CORE\n");
    writeFile(roots[0]!.dir, "skills/a/SKILL.md", "a\n");
    generateAgentConfig({ workspace: ws, roots, preset, gateCommand: "g" });
    const first = readFileSync(join(ws, ".claude", "settings.json"), "utf8") + readFileSync(join(ws, "CLAUDE.md"), "utf8");
    generateAgentConfig({ workspace: ws, roots, preset, gateCommand: "g" });
    const second = readFileSync(join(ws, ".claude", "settings.json"), "utf8") + readFileSync(join(ws, "CLAUDE.md"), "utf8");
    expect(first).toBe(second);
  });
});
