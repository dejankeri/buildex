import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readlinkSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentConfig, defaultLinkStrategy, skillsLinkStale, type Root } from "./agent-config.js";
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

/**
 * Installing an app moves the truth about a whole domain out of the workspace files and into that
 * app. Nothing used to say so, and the consequence was not subtle: with the Protocol pack
 * installed, "who needs me today?" was answered from the demo brain's markdown - four fictional
 * B2B accounts - without a single call to the coaching CRM holding 169 real clients. The agent had
 * even read the Protocol triage skill first; a generic core skill that says "read the brain" simply
 * won, because no rule ranked them.
 *
 * So an installed pack states what it is the system of record for, and that lands in the assembled
 * rules - always in context, rendered from installed state with no model in the loop (invariant 9).
 */
describe("generateAgentConfig - where things live", () => {
  it("names each installed app's system of record in the assembled rules", () => {
    writeFile(roots[0]!.dir, "CLAUDE.md", "CORE RULES\n");
    generateAgentConfig({
      workspace: ws,
      roots,
      preset,
      apps: [
        { name: "Protocol", systemOfRecord: "Clients, their programs and check-ins live in Protocol." },
        { name: "Stripe", systemOfRecord: "Invoices and payments live in Stripe." },
      ],
    });

    const md = readFileSync(join(ws, "CLAUDE.md"), "utf8");
    expect(md).toContain("Protocol");
    expect(md).toContain("Clients, their programs and check-ins live in Protocol.");
    expect(md).toContain("Invoices and payments live in Stripe.");
    // The company's own rules still come first; this is an appendix, not a replacement.
    expect(md.indexOf("CORE RULES")).toBeLessThan(md.indexOf("Clients, their programs"));
  });

  it("says nothing at all when no installed app claims a domain", () => {
    writeFile(roots[0]!.dir, "CLAUDE.md", "CORE RULES\n");
    generateAgentConfig({ workspace: ws, roots, preset, apps: [] });

    const md = readFileSync(join(ws, "CLAUDE.md"), "utf8");
    // An empty section is worse than no section: it reads as "nothing is authoritative".
    expect(md).not.toMatch(/where things live/i);
  });

  it("drops an app that declares nothing, rather than listing it blank", () => {
    generateAgentConfig({
      workspace: ws,
      roots,
      preset,
      apps: [{ name: "Quiet", systemOfRecord: "  " }, { name: "Protocol", systemOfRecord: "Clients live in Protocol." }],
    });

    const md = readFileSync(join(ws, "CLAUDE.md"), "utf8");
    expect(md).not.toContain("Quiet");
    expect(md).toContain("Clients live in Protocol.");
  });

  it("is regenerated, not appended, so an uninstall actually removes the claim", () => {
    generateAgentConfig({
      workspace: ws,
      roots,
      preset,
      apps: [{ name: "Protocol", systemOfRecord: "Clients live in Protocol." }],
    });
    expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).toContain("Clients live in Protocol.");

    // Uninstall: the pack is gone, so its claim on the domain must go with it. A stale claim would
    // point the agent at tools it no longer has.
    generateAgentConfig({ workspace: ws, roots, preset, apps: [] });
    expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).not.toContain("Clients live in Protocol.");
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

/**
 * A verb the AGENT authors has to become discoverable on its own.
 *
 * regenConfig runs at boot, on pack install/uninstall, and when the console's skill editor saves -
 * never on a plain file write. So when the agent takes the operator up on "want me to remember
 * that?" and writes the SKILL.md itself, nothing links it into .claude/skills, and the verb it just
 * promised to remember stays invisible until someone restarts the app. Offering to learn and then
 * not learning is worse than never offering.
 *
 * skillsLinkStale is the cheap check that closes it: three readdirs against the generated manifest,
 * run before a turn, so a verb authored in one turn is linked for the next.
 */
describe("skillsLinkStale - has anything authored a verb behind our back?", () => {
  it("is false right after a generate (the common case costs nothing)", () => {
    writeFile(roots[1]!.dir, "skills/tidy/SKILL.md", "team tidy\n");
    generateAgentConfig({ workspace: ws, roots, preset });
    expect(skillsLinkStale(ws, roots)).toBe(false);
  });

  it("is true once a new verb appears in a root", () => {
    generateAgentConfig({ workspace: ws, roots, preset });
    // The agent writes a remembered verb straight to the team root.
    writeFile(roots[1]!.dir, "skills/how-we-name-programs/SKILL.md", "---\nname: how-we-name-programs\n---\n");
    expect(skillsLinkStale(ws, roots)).toBe(true);
  });

  it("is true once a verb is removed from a root", () => {
    writeFile(roots[1]!.dir, "skills/doomed/SKILL.md", "x\n");
    generateAgentConfig({ workspace: ws, roots, preset });
    rmSync(join(roots[1]!.dir, "skills", "doomed"), { recursive: true, force: true });
    expect(skillsLinkStale(ws, roots)).toBe(true);
  });

  it("notices a verb that moved roots, even though the name set is unchanged", () => {
    writeFile(roots[0]!.dir, "skills/tidy/SKILL.md", "core tidy\n");
    generateAgentConfig({ workspace: ws, roots, preset });
    expect(skillsLinkStale(ws, roots)).toBe(false);

    // A team copy now shadows core. Same names, different winner - the link must be rebuilt or the
    // operator's override silently does nothing.
    writeFile(roots[1]!.dir, "skills/tidy/SKILL.md", "team tidy\n");
    expect(skillsLinkStale(ws, roots)).toBe(true);
  });

  it("is true when the manifest is missing entirely (never generated, or wiped)", () => {
    writeFile(roots[1]!.dir, "skills/tidy/SKILL.md", "team tidy\n");
    expect(skillsLinkStale(ws, roots)).toBe(true);
  });
});
