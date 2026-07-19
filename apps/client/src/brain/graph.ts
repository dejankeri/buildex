// Deterministic knowledge-graph renderer (invariant 9). Ported from the prototype
// and hardened: all output is sorted so a double-render is byte-identical (the determinism release
// gate). Pure - reads files, involves zero LLM. Renders the live workspace map.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, dirname, basename } from "node:path";

export interface GraphNode {
  id: string;
  kind: "file" | "folder";
  label: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  kind: "link";
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Root {
  name: string;
  dir: string;
}

const IGNORED = new Set([".git", ".conflicts", ".sessions", ".agent", "node_modules"]);

// Skill manifests (`skills/<name>/SKILL.md`, and any nested skill folder) are the agent's *verbs*,
// surfaced in the Skills panel - not brain documents. A real workspace installs dozens of packs, so
// including them here floods the map with identical "SKILL.md" nodes and drowns the actual company
// brain. They are excluded from the knowledge graph; the map shows documents, not tooling.
function isSkillManifest(rel: string): boolean {
  return /(^|\/)skills\/.*\/SKILL\.md$/.test(rel);
}

/** Build the deterministic knowledge graph across one or more repo roots. */
export function buildGraph(roots: Root[]): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Set<string>(); // "from\tto" - dedup
  // basename (without .md) → node id, for wikilink resolution (last write wins, but we resolve
  // deterministically by sorting inputs first).
  const byBasename = new Map<string, string>();

  const files: { id: string; abs: string; root: Root }[] = [];
  for (const root of roots) {
    for (const abs of walkMarkdown(root.dir)) {
      const rel = toPosix(relative(root.dir, abs));
      if (isSkillManifest(rel)) continue; // tooling, not a brain document (keeps the map legible)
      const id = `${root.name}/${rel}`;
      files.push({ id, abs, root });
    }
  }
  files.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const f of files) {
    nodes.set(f.id, { id: f.id, kind: "file", label: basename(f.id) });
    byBasename.set(basename(f.id).replace(/\.md$/, ""), f.id);
  }

  for (const f of files) {
    const text = safeRead(f.abs);
    for (const target of resolveLinks(text, f, byBasename, roots)) {
      if (nodes.has(target)) edges.add(`${f.id}\t${target}`);
    }
  }

  return {
    nodes: [...nodes.values()].sort(cmpNode),
    edges: [...edges]
      .map((e) => {
        const [from, to] = e.split("\t");
        return { from: from!, to: to!, kind: "link" as const };
      })
      .sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1)),
  };
}

/** Markdown docs changed vs the git index/HEAD (for the "recently touched" map highlight). */
export function changedDocs(repoDir: string): string[] {
  const out = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" });
  const files = out
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((f) => f.endsWith(".md"));
  return [...new Set(files)].sort();
}

// --- internals ---

function* walkMarkdown(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || IGNORED.has(entry)) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) yield* walkMarkdown(abs);
    else if (entry.endsWith(".md")) yield abs;
  }
}

function resolveLinks(
  text: string,
  file: { id: string; abs: string; root: Root },
  byBasename: Map<string, string>,
  roots: Root[],
): string[] {
  const out = new Set<string>();
  // [[wikilink]] by basename
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const name = m[1]!.trim().replace(/\.md$/, "");
    const target = byBasename.get(name);
    if (target) out.add(target);
  }
  // [text](relative.md) - resolve relative to this file, within a known root
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+\.md)\)/g)) {
    const href = m[1]!.trim();
    if (/^https?:/.test(href)) continue;
    const abs = join(dirname(file.abs), href);
    for (const root of roots) {
      const rel = relative(root.dir, abs);
      if (!rel.startsWith("..")) {
        out.add(`${root.name}/${toPosix(rel)}`);
        break;
      }
    }
  }
  return [...out];
}

function cmpNode(a: GraphNode, b: GraphNode): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function toPosix(p: string): string {
  return p.split("\\").join("/");
}
function safeRead(abs: string): string {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}
