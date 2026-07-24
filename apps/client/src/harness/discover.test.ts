// Hermetic tests for the pack's Surface: skill discovery off real tmpdir fixtures (frontmatter
// parsing, precedence, fail-soft), composition with a faked mcp fetch (mirrors mcp-tools.test.ts's
// res()/plain() idiom), the surface.json round trip, and diffSurface's name-set comparison.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, discoverSurface, writeSurface, diffSurface, type Surface } from "./discover.js";
import type { Root } from "../brain/graph.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function makeRoot(base: string, name: string): Root {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return { name, dir };
}

/** Write `<root>/skills/<dirName>/SKILL.md` with the given raw text; pass null to create the skill
 *  dir with no SKILL.md at all (the "missing manifest" fail-soft case). */
function writeSkill(root: Root, dirName: string, text: string | null): void {
  const skillDir = join(root.dir, "skills", dirName);
  mkdirSync(skillDir, { recursive: true });
  if (text !== null) writeFileSync(join(skillDir, "SKILL.md"), text);
}

const fm = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n# body\n`;

describe("discoverSkills", () => {
  it("resolves same-named skill dirs by precedence: private > team > core (roots given low->high)", () => {
    const base = tmp("discover-");
    const core = makeRoot(base, "core");
    const team = makeRoot(base, "team-acme");
    const priv = makeRoot(base, "private-you");

    writeSkill(core, "shared-skill", fm("shared-skill", "core version"));
    writeSkill(team, "shared-skill", fm("shared-skill", "team version"));
    writeSkill(priv, "shared-skill", fm("shared-skill", "private version"));
    writeSkill(core, "core-only", fm("core-only", "only in core"));

    // shared-skill is in the pack set, so its non-core (team/private) copies survive scoping and
    // precedence still resolves private > team > core; core-only rides in as a core always-on skill.
    expect(discoverSkills([core, team, priv], ["shared-skill"])).toEqual([
      { name: "core-only", description: "only in core" },
      { name: "shared-skill", description: "private version" },
    ]);
  });

  it("scopes to the pack under test: keeps core always-on skills + the pack's declared skills, drops other packs' skills", () => {
    const base = tmp("discover-");
    const core = makeRoot(base, "core");
    const team = makeRoot(base, "team-acme");

    writeSkill(core, "capture-decision", fm("capture-decision", "always-on core skill"));
    writeSkill(team, "protocol-scheduling", fm("protocol-scheduling", "pack under test"));
    writeSkill(team, "stripe-billing", fm("stripe-billing", "a DIFFERENT pack's skill"));
    writeSkill(team, "linear-issue", fm("linear-issue", "another pack's skill"));

    // pack under test declares only its own skills; core is always kept, foreign packs dropped.
    expect(discoverSkills([core, team], ["protocol-scheduling"])).toEqual([
      { name: "capture-decision", description: "always-on core skill" },
      { name: "protocol-scheduling", description: "pack under test" },
    ]);
  });

  it("lists a skill by its directory name with an empty description when SKILL.md is missing", () => {
    const base = tmp("discover-");
    const core = makeRoot(base, "core");
    writeSkill(core, "no-manifest", null);
    expect(discoverSkills([core], [])).toEqual([{ name: "no-manifest", description: "" }]);
  });

  it("fails soft on frontmatter missing the closing fence", () => {
    const base = tmp("discover-");
    const core = makeRoot(base, "core");
    writeSkill(core, "broken", "---\nname: broken\ndescription: no closing fence\n# body\n");
    expect(discoverSkills([core], [])).toEqual([{ name: "broken", description: "" }]);
  });

  it("fails soft on a SKILL.md with no frontmatter fences at all", () => {
    const base = tmp("discover-");
    const core = makeRoot(base, "core");
    writeSkill(core, "plain", "# Just a heading\nNo frontmatter here.\n");
    expect(discoverSkills([core], [])).toEqual([{ name: "plain", description: "" }]);
  });

  it("falls back to the directory name when the name: line is absent, keeping the parsed description", () => {
    const base = tmp("discover-");
    const core = makeRoot(base, "core");
    writeSkill(core, "unnamed", "---\ndescription: has a description, no name\n---\n");
    expect(discoverSkills([core], [])).toEqual([{ name: "unnamed", description: "has a description, no name" }]);
  });

  it("keeps colons in the description intact (splits on the first ': ' only)", () => {
    const base = tmp("discover-");
    const core = makeRoot(base, "core");
    writeSkill(core, "colon-desc", fm("colon-desc", "Ratio is 3: 2, handle it: carefully"));
    expect(discoverSkills([core], [])).toEqual([{ name: "colon-desc", description: "Ratio is 3: 2, handle it: carefully" }]);
  });

  it("treats a root with no skills/ dir at all as normal, not an error", () => {
    const base = tmp("discover-");
    const core = makeRoot(base, "core"); // no skills/ subdir created
    expect(discoverSkills([core], [])).toEqual([]);
  });
});

describe("discoverSurface", () => {
  const okTools = [
    { name: "b_tool", description: "does b" },
    { name: "a_tool", description: "does a" },
  ];
  const plain = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });
  const res = (status: number, text: string, headers: Record<string, string> = {}) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      headers: { get: (k: string) => headers[k] ?? null },
    }) as unknown as Response;

  it("composes discovered skills with the live mcp server's tools into one Surface", async () => {
    const base = tmp("discover-");
    const core = makeRoot(base, "core");
    writeSkill(core, "acme-howto", fm("acme-howto", "how to use acme"));

    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, plain({}))).mockResolvedValueOnce(res(200, plain({ tools: okTools })));

    const surface = await discoverSurface(
      { pack: "acme", roots: [core], mcpUrl: "https://mcp.example.com", headers: {}, packSkills: [] },
      { fetch: fetchMock as unknown as typeof globalThis.fetch },
    );

    expect(surface).toEqual({
      pack: "acme",
      skills: [{ name: "acme-howto", description: "how to use acme" }],
      tools: [
        { name: "a_tool", description: "does a" },
        { name: "b_tool", description: "does b" },
      ],
    });
  });
});

describe("writeSurface", () => {
  it("round-trips to <runDir>/surface.json with skills sorted by name (tools kept as given)", () => {
    const runDir = tmp("discover-write-");
    const s: Surface = {
      pack: "acme",
      skills: [
        { name: "z-skill", description: "z" },
        { name: "a-skill", description: "a" },
      ],
      tools: [
        { name: "b_tool", description: "b" },
        { name: "a_tool", description: "a" },
      ],
    };
    const path = writeSurface(runDir, s);
    expect(path).toBe(join(runDir, "surface.json"));

    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({
      pack: "acme",
      skills: [
        { name: "a-skill", description: "a" },
        { name: "z-skill", description: "z" },
      ],
      tools: [
        { name: "b_tool", description: "b" },
        { name: "a_tool", description: "a" },
      ],
    });
  });
});

describe("diffSurface", () => {
  const surface = (skills: string[], tools: string[]): Surface => ({
    pack: "acme",
    skills: skills.map((name) => ({ name, description: "" })),
    tools: tools.map((name) => ({ name, description: "" })),
  });

  it("reports clean=true when skill and tool NAME sets are identical (descriptions may differ)", () => {
    const baseline: Surface = { pack: "acme", skills: [{ name: "a", description: "old" }], tools: [{ name: "t", description: "old" }] };
    const current: Surface = { pack: "acme", skills: [{ name: "a", description: "new" }], tools: [{ name: "t", description: "new" }] };
    expect(diffSurface(baseline, current)).toEqual({ addedSkills: [], removedSkills: [], addedTools: [], removedTools: [], clean: true });
  });

  it("reports added and removed skills and tools, sorted, clean=false", () => {
    const baseline = surface(["kept-skill", "gone-skill"], ["kept-tool", "gone-tool"]);
    const current = surface(["kept-skill", "new-skill"], ["kept-tool", "new-tool"]);
    expect(diffSurface(baseline, current)).toEqual({
      addedSkills: ["new-skill"],
      removedSkills: ["gone-skill"],
      addedTools: ["new-tool"],
      removedTools: ["gone-tool"],
      clean: false,
    });
  });
});
