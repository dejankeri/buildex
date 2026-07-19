// The agent's derived "hook" surface, read deterministically from the workspace (invariant #9, zero
// LLM). regenConfig() materializes `.claude/skills/*` (symlinks, precedence private>team>core), a
// `skill-origins.json` provenance manifest, `.claude/settings.json` (policy preset + gate hook), an
// assembled workspace `CLAUDE.md`, and `.mcp.json` (pinned MCP servers, incl. installed pack faces).
// This module turns those files into a health summary + a tree fragment for the Files panel's
// "Agent (.claude)" reveal - so an operator can confirm every skill (incl. app-pack skills) and every
// pinned tool actually landed where the agent looks, and the workspace stays tidy.
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
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
    // A skill is a FOLDER of its actual source files (SKILL.md + any scripts/references), each openable
    // by the root-confined doc reader - so the operator can read them, not stare at an empty folder.
    // Collapsed by default to keep a long skills list tidy.
    skillNodes.push({
      name,
      type: "dir",
      path: `${root}/skills/${name}`,
      note: isPack ? `${root} · app` : root,
      collapsed: true,
      children: skillChildren(workspace, root, name),
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

/** List a skill's SOURCE directory (`<workspace>/<root>/skills/<name>/`) as readable tree nodes with
 *  root-relative paths, so the existing root-confined doc reader can open each file. Depth-limited,
 *  hidden entries skipped, entries sorted. Guarantees a SKILL.md node even if the directory can't be
 *  walked (a stale link), so a skill is never an empty, unreadable folder. */
function skillChildren(workspace: string, root: string, name: string): TreeNode[] {
  const rel = `${root}/skills/${name}`;
  const walk = (absDir: string, relDir: string, depth: number): TreeNode[] => {
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: TreeNode[] = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const childRel = `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        out.push({ name: e.name, type: "dir", path: childRel, collapsed: true, children: depth > 0 ? walk(join(absDir, e.name), childRel, depth - 1) : [] });
      } else if (e.isFile()) {
        out.push({ name: e.name, type: "file", path: childRel });
      }
    }
    return out;
  };
  const kids = walk(join(workspace, root, "skills", name), rel, 2);
  if (!kids.some((k) => k.type === "file" && k.name === "SKILL.md")) {
    kids.unshift({ name: "SKILL.md", type: "file", path: `${rel}/SKILL.md` });
  }
  return kids;
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
