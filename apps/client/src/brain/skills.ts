// Skills the operator can read, teach, and run from the console. A skill is a verb - a
// `<repo>/skills/<name>/SKILL.md` that `generateAgentConfig` symlinks into `.claude/skills` with
// precedence private>team>core, so the agent discovers it natively (no wrapper protocol).
//
// The authoring quality check here mirrors apps/toolkit's promotion-checklist (the shipping gate for
// packs/core). This is the earlier, in-console copy - it warns while you type so a saved verb is one
// the agent will actually reach for. Keep the two rule sets in step.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { confinePath } from "../lib/confine-path.js";
import type { Root } from "./graph.js";

export interface SkillDetail {
  name: string;
  description: string;
  content: string;
  /** The repo the winning copy came from (core/team/private) - precedence resolved. */
  origin: string;
}

export interface ComposeInput {
  name: string;
  description: string;
  /** The markdown body (H1 + When to use / Steps / Rules). */
  instructions: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: string[];
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const TRIGGER_HINTS = /\b(use when|use this when|when you|when the)\b/i;

/** The console's teach-a-verb check - mirrors the toolkit promotion checklist. */
export function validateSkill(content: string): ValidationResult {
  const issues: string[] = [];
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { ok: false, issues: ["missing YAML frontmatter"] };
  const front = fm[1]!;
  const name = field(front, "name");
  const description = field(front, "description");

  if (!name) issues.push("missing `name`");
  else if (!NAME_RE.test(name)) issues.push("`name` must be kebab-case (lower-case, hyphens)");

  if (!description) issues.push("missing `description`");
  else {
    if (description.length < 30) issues.push("`description` is too terse to guide discovery");
    if (!TRIGGER_HINTS.test(description)) issues.push('`description` should be trigger-oriented ("Use when …") so the agent knows when to reach for it');
  }

  const body = content.slice(fm[0].length);
  if (!/^#\s+\S/m.test(body)) issues.push("missing an H1 title");
  if (!/##\s+When to use/i.test(body) && !/##\s+Steps/i.test(body)) issues.push("missing a `## When to use` or `## Steps` section");

  return { ok: issues.length === 0, issues };
}

/** Compose a SKILL.md from editor fields. Frontmatter is authored, never hand-typed by the operator. */
export function composeSkill(input: ComposeInput): string {
  const desc = input.description.replace(/\r?\n/g, " ").trim();
  return `---\nname: ${input.name.trim()}\ndescription: ${desc}\n---\n\n${input.instructions.trim()}\n`;
}

/** The starter body shown in a fresh editor - passes the checklist as-is so saving is never blocked. */
export function skillTemplate(name: string): string {
  const n = name || "my-verb";
  return `# ${n}\n\n## When to use\n\n- Describe the trigger - the situation where the agent should reach for this.\n\n## Steps\n\n1. First do this.\n2. Then this.\n\n## Rules\n\n- Keep outputs plain markdown; nothing secret.\n`;
}

/** Read a skill's full content + which repo the precedence winner came from. Content is read through
 *  the generated .claude/skills/<name> entry - works whether it's a symlink, a junction, or a plain
 *  copy - with a roots scan as fallback when the config hasn't been generated yet. */
export function readSkill(workspace: string, roots: Root[], name: string): SkillDetail {
  assertName(name);
  const link = join(workspace, ".claude", "skills", name);
  let skillDir: string | undefined;
  if (existsSync(join(link, "SKILL.md"))) {
    skillDir = link;
  } else {
    // Fall back to scanning roots in precedence order (last wins).
    for (const r of roots) {
      const d = join(r.dir, "skills", name);
      if (existsSync(join(d, "SKILL.md"))) skillDir = d;
    }
  }
  if (!skillDir || !existsSync(join(skillDir, "SKILL.md"))) throw new Error(`skill not found: ${name}`);
  const content = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  const description = fm ? field(fm[1]!, "description") ?? "" : "";
  const origin = originOf(workspace, roots, name, skillDir);
  return { name, description, content, origin };
}

/** Write a skill's SKILL.md into a named repo's skills/ dir (path-guarded). Returns the file path. */
export function writeSkillFile(roots: Root[], opts: { name: string; repo: string; content: string }): { path: string } {
  assertName(opts.name);
  const root = roots.find((r) => r.name === opts.repo);
  if (!root) throw new Error(`unknown repo: ${opts.repo}`);
  const skillDir = join(root.dir, "skills", opts.name);
  // Guard: the resolved dir must stay inside the repo's skills/ (defence in depth beyond assertName;
  // separator-safe + symlink-safe - lib/confine-path, the one shared implementation).
  if (confinePath(join(root.dir, "skills"), opts.name) === null) throw new Error(`skill path escapes repo: ${opts.name}`);
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  writeFileSync(path, opts.content);
  return { path };
}

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid skill name (must be kebab-case): ${name}`);
}

/** Which repo the winning skill came from. Prefer the generated manifest (survives junctions and
 *  copies, where the link target can't be read back); otherwise infer from the canonical path. */
function originOf(workspace: string, roots: Root[], name: string, skillDir: string): string {
  const manifest = join(workspace, ".claude", "skill-origins.json");
  if (existsSync(manifest)) {
    try {
      const m = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
      if (typeof m[name] === "string") return m[name] as string;
    } catch {
      // malformed manifest - fall through to path inference
    }
  }
  // Canonicalize both sides (resolves symlinks + the macOS /var → /private/var alias) before comparing.
  const abs = realpathSafe(skillDir);
  for (const r of roots) {
    const rd = realpathSafe(r.dir);
    if (abs === rd || abs.startsWith(rd + sep)) return r.name;
  }
  return "";
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function field(front: string, key: string): string | undefined {
  const m = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1]!.trim() : undefined;
}
