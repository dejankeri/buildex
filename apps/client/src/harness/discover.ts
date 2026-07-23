// The pack's Surface: the discover-don't-hardcode seam later tasks generate scenarios from. Two
// halves composed into one deterministic-shaped artifact - skills walked off disk (precedence-
// resolved the same way brain/agent-config.ts's linkSkills resolves them) and mcp tools (Task 1's
// listMcpTools, a live handshake against the pack's mcp server).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listMcpTools, type McpTool } from "./mcp-tools.js";
import type { Root } from "../brain/graph.js";

export interface Surface {
  pack: string;
  skills: { name: string; description: string }[];
  tools: McpTool[];
}

/** Parse the house-style SKILL.md frontmatter: the `name:`/`description:` lines between the first
 *  pair of `---` fences. No yaml dependency - each line is split on the first ": " so a description
 *  containing its own colons survives intact. Anything short of a well-formed fenced block (no
 *  opening fence, no closing fence, line missing the "key: value" shape) simply omits that key -
 *  fail-soft, the caller falls back to the directory name / empty description. */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const closeAt = lines.slice(1).findIndex((l) => l.trim() === "---");
  if (closeAt === -1) return {};

  const out: { name?: string; description?: string } = {};
  for (const line of lines.slice(1, 1 + closeAt)) {
    const sep = line.indexOf(": ");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 2).trim();
    if (key === "name") out.name = value;
    else if (key === "description") out.description = value;
  }
  return out;
}

/** One skill dir's {name, description} - frontmatter's values when SKILL.md parses, the directory
 *  name and an empty description otherwise (missing file, missing fences, missing `name:` line -
 *  all fail soft; a broken SKILL.md must never take down discovery). */
function readSkillEntry(skillsDir: string, dirName: string): { name: string; description: string } {
  let text: string;
  try {
    text = readFileSync(join(skillsDir, dirName, "SKILL.md"), "utf8");
  } catch {
    return { name: dirName, description: "" };
  }
  const fm = parseFrontmatter(text);
  return { name: fm.name || dirName, description: fm.description ?? "" };
}

/** Walk `<root>/skills/*` across every root, ascending precedence (roots given low→high - a later
 *  root's skill overrides an earlier one's same-named DIRECTORY, mirroring brain/agent-config.ts's
 *  linkSkills). A root with no skills/ dir at all is normal, not an error. Returns skills sorted by
 *  name. */
export function discoverSkills(roots: Root[]): Surface["skills"] {
  const resolved = new Map<string, { name: string; description: string }>(); // keyed by directory name
  for (const root of roots) {
    const skillsDir = join(root.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    for (const dirName of readdirSync(skillsDir).sort()) {
      if (!statSync(join(skillsDir, dirName)).isDirectory()) continue;
      resolved.set(dirName, readSkillEntry(skillsDir, dirName));
    }
  }
  return [...resolved.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Build the pack's full Surface: skills off disk plus the live mcp server's tools (Task 1's
 *  listMcpTools) - the seam later tasks generate scenarios from instead of hardcoding either half. */
export async function discoverSurface(
  opts: { pack: string; roots: Root[]; mcpUrl: string; headers: Record<string, string> },
  deps: { fetch: typeof globalThis.fetch },
): Promise<Surface> {
  const skills = discoverSkills(opts.roots);
  const tools = await listMcpTools({ url: opts.mcpUrl, headers: opts.headers }, deps);
  return { pack: opts.pack, skills, tools };
}

/** Write the run's surface artifact: `<runDir>/surface.json`, stably ordered (skills sorted by
 *  name; tools kept as given - listMcpTools already hands them back sorted). Returns the path. */
export function writeSurface(runDir: string, s: Surface): string {
  const path = join(runDir, "surface.json");
  const stable: Surface = { pack: s.pack, skills: [...s.skills].sort((a, b) => a.name.localeCompare(b.name)), tools: s.tools };
  writeFileSync(path, JSON.stringify(stable, null, 2) + "\n");
  return path;
}

/** Compare two surfaces by NAME sets only (never descriptions - a reworded skill/tool isn't drift).
 *  "added" means present in `current` but not `baseline`, and vice versa for "removed"; `clean` is
 *  true only when all four lists are empty. */
export function diffSurface(
  baseline: Surface,
  current: Surface,
): { addedSkills: string[]; removedSkills: string[]; addedTools: string[]; removedTools: string[]; clean: boolean } {
  const names = (list: { name: string }[]) => new Set(list.map((x) => x.name));
  const added = (base: Set<string>, cur: Set<string>) => [...cur].filter((n) => !base.has(n)).sort();
  const removed = (base: Set<string>, cur: Set<string>) => [...base].filter((n) => !cur.has(n)).sort();

  const baseSkills = names(baseline.skills);
  const curSkills = names(current.skills);
  const baseTools = names(baseline.tools);
  const curTools = names(current.tools);

  const addedSkills = added(baseSkills, curSkills);
  const removedSkills = removed(baseSkills, curSkills);
  const addedTools = added(baseTools, curTools);
  const removedTools = removed(baseTools, curTools);

  return {
    addedSkills,
    removedSkills,
    addedTools,
    removedTools,
    clean: addedSkills.length === 0 && removedSkills.length === 0 && addedTools.length === 0 && removedTools.length === 0,
  };
}
