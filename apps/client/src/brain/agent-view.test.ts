import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentView } from "./agent-view.js";
import type { Root } from "./graph.js";

let ws: string;

function write(rel: string, body: string): void {
  const f = join(ws, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, body);
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "buildex-agentview-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("buildAgentView", () => {
  it("summarizes skills by origin, attributes pack skills, and counts MCP servers", () => {
    write(".claude/skill-origins.json", JSON.stringify({
      "tidy": "core",
      "gmail-triage": "team-acme",
      "gmail-draft": "team-acme",
      "calendly-schedule": "private-you",
    }));
    write(".claude/settings.json", "{}");
    write("CLAUDE.md", "# rules\n");
    write(".mcp.json", JSON.stringify({ mcpServers: {
      "buildex-pack:gmail": { type: "http", url: "https://gmailmcp.googleapis.com/mcp/v1" },
      "buildex-pack:calendly": { type: "http", url: "https://mcp.calendly.com" },
      "some-other": { type: "http", url: "https://x" },
    } }));

    const packSkills = new Set(["gmail-triage", "gmail-draft", "calendly-schedule"]);
    const { summary } = buildAgentView(ws, packSkills);

    expect(summary.skills.total).toBe(4);
    expect(summary.skills.byRoot).toEqual({ "core": 1, "team-acme": 2, "private-you": 1 });
    expect(summary.skills.fromPacks).toBe(3);
    expect(summary.mcp).toEqual({ total: 3, fromPacks: 2, servers: ["buildex-pack:gmail", "buildex-pack:calendly", "some-other"] });
    expect(summary.policyOk).toBe(true);
    expect(summary.claudeMdOk).toBe(true);
  });

  it("builds a derived tree node: CLAUDE.md, .mcp.json, skills, settings, origins", () => {
    write(".claude/skill-origins.json", JSON.stringify({ "gmail-triage": "team-acme" }));
    write(".claude/settings.json", "{}");
    write("CLAUDE.md", "# rules\n");
    write(".mcp.json", JSON.stringify({ mcpServers: { "buildex-pack:gmail": { type: "http", url: "https://g" } } }));

    const { tree } = buildAgentView(ws, new Set(["gmail-triage"]));
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root.name).toMatch(/Agent/i);
    const childNames = (root.children ?? []).map((c) => c.name);
    expect(childNames).toContain("CLAUDE.md");
    expect(childNames).toContain(".mcp.json");
    expect(childNames.some((n) => n.startsWith("skills"))).toBe(true);

    // a linked skill is a COLLAPSED folder badged with its origin; even with no source dir on disk it
    // still exposes a readable SKILL.md child pointing at the origin root (openable by the doc reader).
    const skillsNode = (root.children ?? []).find((c) => c.name.startsWith("skills"))!;
    const gmail = (skillsNode.children ?? []).find((c) => c.name === "gmail-triage")!;
    expect(gmail.type).toBe("dir");
    expect(gmail.path).toBe("team-acme/skills/gmail-triage");
    expect(gmail.collapsed).toBe(true);
    expect(gmail.note).toMatch(/app/);
    const skillMd = (gmail.children ?? []).find((c) => c.name === "SKILL.md")!;
    expect(skillMd.type).toBe("file");
    expect(skillMd.path).toBe("team-acme/skills/gmail-triage/SKILL.md");
  });

  it("lists a skill's REAL source files (SKILL.md + extras) as readable children", () => {
    write(".claude/skill-origins.json", JSON.stringify({ "notion-search": "team-acme" }));
    // A skill folder with more than just SKILL.md - a helper script under a subdir.
    write("team-acme/skills/notion-search/SKILL.md", "# Notion search\n");
    write("team-acme/skills/notion-search/scripts/run.py", "print('hi')\n");

    const { tree } = buildAgentView(ws, new Set());
    const skillsNode = (tree[0]!.children ?? []).find((c) => c.name.startsWith("skills"))!;
    const skill = (skillsNode.children ?? []).find((c) => c.name === "notion-search")!;
    const names = (skill.children ?? []).map((c) => c.name);
    expect(names).toContain("SKILL.md");
    expect(names).toContain("scripts");
    // the SKILL.md is a readable file node with a root-relative path
    const md = (skill.children ?? []).find((c) => c.name === "SKILL.md")!;
    expect(md.type).toBe("file");
    expect(md.path).toBe("team-acme/skills/notion-search/SKILL.md");
    // the subdir is a nested folder whose file is also openable
    const scripts = (skill.children ?? []).find((c) => c.name === "scripts")!;
    expect(scripts.type).toBe("dir");
    expect((scripts.children ?? [])[0]!.path).toBe("team-acme/skills/notion-search/scripts/run.py");
  });

  it("degrades cleanly when the workspace has no generated agent config", () => {
    const { summary, tree } = buildAgentView(ws, new Set());
    expect(summary.skills.total).toBe(0);
    expect(summary.mcp.total).toBe(0);
    expect(summary.policyOk).toBe(false);
    expect(summary.claudeMdOk).toBe(false);
    expect(tree).toHaveLength(1); // the node still renders, just with empty/absent children
  });

  it("flags an authored-but-unlinked verb — the check that proves the brain reached the agent", () => {
    // 'linked-verb' authored AND in origins → wired. 'orphan-verb' authored but NOT in origins → the
    // agent will never see it. That gap is the whole reason the viewer exists.
    write("CLAUDE.md", "# rules\n");
    write(".claude/settings.json", "{}");
    write(".claude/skill-origins.json", JSON.stringify({ "linked-verb": "team-acme" }));
    write("team-acme/skills/linked-verb/SKILL.md", "# linked\n");
    write("team-acme/skills/orphan-verb/SKILL.md", "# orphan\n");
    const roots: Root[] = [{ name: "team-acme", dir: join(ws, "team-acme") }];

    const { summary, discrepancies } = buildAgentView(ws, new Set(), roots);
    expect(summary.skills.total).toBe(1); // only the linked one is seen
    expect(summary.skills.authored).toBe(2); // but two exist on disk
    const unlinked = discrepancies.filter((d) => d.kind === "skill-unlinked");
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]!.path).toBe("team-acme/skills/orphan-verb/SKILL.md");
    expect(unlinked[0]!.message).toContain("orphan-verb");
  });

  it("flags missing standing instructions and missing policy", () => {
    write(".claude/skill-origins.json", JSON.stringify({ "tidy": "core" }));
    // no CLAUDE.md, no settings.json
    const { discrepancies } = buildAgentView(ws, new Set());
    expect(discrepancies.map((d) => d.kind).sort()).toEqual(["claudemd-missing", "policy-missing"]);
  });

  it("reports no discrepancies when everything authored is linked and the standing files exist", () => {
    write("CLAUDE.md", "# rules\n");
    write(".claude/settings.json", "{}");
    write(".claude/skill-origins.json", JSON.stringify({ "tidy": "team-acme" }));
    write("team-acme/skills/tidy/SKILL.md", "# tidy\n");
    const roots: Root[] = [{ name: "team-acme", dir: join(ws, "team-acme") }];
    expect(buildAgentView(ws, new Set(), roots).discrepancies).toEqual([]);
  });
});
