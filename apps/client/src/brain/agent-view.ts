// The agent's derived "hook" surface, read deterministically from the workspace (invariant #9, zero
// LLM). regenConfig() materializes `.claude/skills/*` (symlinks, precedence private>team>core), a
// `skill-origins.json` provenance manifest, `.claude/settings.json` (policy preset + gate hook), an
// assembled workspace `CLAUDE.md`, and `.mcp.json` (pinned MCP servers, incl. installed pack faces).
// This module turns those files into a health summary + a tree fragment for the Files panel's
// "Agent (.claude)" reveal - so an operator can confirm every skill (incl. app-pack skills) and every
// pinned tool actually landed where the agent looks, and the workspace stays tidy.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TreeNode } from "../daemon/daemon.js";

const PACK_MCP_PREFIX = "buildex-pack:";

export interface AgentViewSummary {
  skills: { total: number; byRoot: Record<string, number>; fromPacks: number };
  mcp: { total: number; fromPacks: number };
  /** `.claude/settings.json` present (the allow/ask/deny preset + gate hook). */
  policyOk: boolean;
  /** assembled workspace `CLAUDE.md` present. */
  claudeMdOk: boolean;
}
export interface AgentView {
  summary: AgentViewSummary;
  tree: TreeNode[];
}

/** Derive the agent-surface view for a workspace. `packSkills` is the union of declared skill names
 *  across INSTALLED packs - used to badge which linked skills came from an app pack (pass an empty
 *  set if unknown; attribution simply degrades to none). Never throws: missing/partial config yields
 *  zeroed counts and an (almost) empty node, so a not-yet-synced workspace renders cleanly. */
export function buildAgentView(workspace: string, packSkills: Set<string> = new Set()): AgentView {
  const claudeDir = join(workspace, ".claude");
  const origins = readOrigins(join(claudeDir, "skill-origins.json"));
  const names = Object.keys(origins).sort();

  const byRoot: Record<string, number> = {};
  let fromPacks = 0;
  const skillNodes: TreeNode[] = [];
  for (const name of names) {
    const root = origins[name]!;
    byRoot[root] = (byRoot[root] ?? 0) + 1;
    const isPack = packSkills.has(name);
    if (isPack) fromPacks++;
    skillNodes.push({
      name,
      type: "dir",
      // Point at the source SKILL.md in its origin root, so the existing (root-confined) doc reader
      // can open it - the `.claude/skills/<name>` link itself is not under a repo root.
      path: `${root}/skills/${name}/SKILL.md`,
      note: isPack ? `${root} · app` : root,
    });
  }

  const mcp = readMcp(join(workspace, ".mcp.json"));
  const policyOk = existsSync(join(claudeDir, "settings.json"));
  const claudeMdOk = existsSync(join(workspace, "CLAUDE.md"));

  const summary: AgentViewSummary = {
    skills: { total: names.length, byRoot, fromPacks },
    mcp,
    policyOk,
    claudeMdOk,
  };

  // The synthetic "Agent (.claude)" node revealed in the Files tree. Files that live at the workspace
  // root (CLAUDE.md / .mcp.json) or under .claude are surfaced together here.
  const children: TreeNode[] = [];
  if (claudeMdOk) children.push({ name: "CLAUDE.md", type: "file", path: "CLAUDE.md", note: "assembled rules" });
  if (mcp.total) children.push({ name: ".mcp.json", type: "file", path: ".mcp.json", note: mcp.total === 1 ? "1 MCP server" : `${mcp.total} MCP servers` });
  children.push({ name: `skills (${names.length})`, type: "dir", path: ".claude/skills", children: skillNodes });
  if (policyOk) children.push({ name: "settings.json", type: "file", path: ".claude/settings.json", note: "policy + gate hook" });
  if (existsSync(join(claudeDir, "skill-origins.json"))) children.push({ name: "skill-origins.json", type: "file", path: ".claude/skill-origins.json", note: "provenance" });

  const tree: TreeNode[] = [{ name: "Agent (.claude)", type: "dir", path: ".claude", children }];
  return { summary, tree };
}

function readOrigins(file: string): Record<string, string> {
  try {
    const o = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (o && typeof o === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
      return out;
    }
  } catch { /* missing or malformed → no skills */ }
  return {};
}

function readMcp(file: string): { total: number; fromPacks: number } {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
    const servers = j && j.mcpServers && typeof j.mcpServers === "object" ? Object.keys(j.mcpServers) : [];
    return { total: servers.length, fromPacks: servers.filter((k) => k.startsWith(PACK_MCP_PREFIX)).length };
  } catch {
    return { total: 0, fromPacks: 0 };
  }
}
