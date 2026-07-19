import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentView } from "./agent-view.js";

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
    expect(summary.mcp).toEqual({ total: 3, fromPacks: 2 });
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

    // a linked skill points at its source SKILL.md in the origin root (openable by the doc reader),
    // and is badged as coming from an app pack.
    const skillsNode = (root.children ?? []).find((c) => c.name.startsWith("skills"))!;
    const gmail = (skillsNode.children ?? []).find((c) => c.name === "gmail-triage")!;
    expect(gmail.path).toBe("team-acme/skills/gmail-triage/SKILL.md");
    expect(gmail.note).toMatch(/app/);
  });

  it("degrades cleanly when the workspace has no generated agent config", () => {
    const { summary, tree } = buildAgentView(ws, new Set());
    expect(summary.skills.total).toBe(0);
    expect(summary.mcp.total).toBe(0);
    expect(summary.policyOk).toBe(false);
    expect(summary.claudeMdOk).toBe(false);
    expect(tree).toHaveLength(1); // the node still renders, just with empty/absent children
  });
});
