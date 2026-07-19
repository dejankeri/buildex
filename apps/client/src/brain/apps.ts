// The Apps surface (plus the external-app extension). An app is a folder `<root>/apps/<name>/`
// with an app.json manifest, resolved across roots with precedence private>team>core - the same
// model as brain/skills.ts. A `local` app ships HTML run in an opaque-origin sandbox; an
// `external` app is a remote URL embedded in a webview. This module is the deterministic catalog
// (invariant 9 - rendered from repo state, zero LLM) plus the path-confined create/read surface.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { confinePath } from "../lib/confine-path.js";
import type { Root } from "./graph.js";

export interface AppManifest {
  name?: string;
  icon?: string;
  kind: "local" | "external";
  entry?: string;
  url?: string;
  data?: { read?: boolean; write?: boolean };
}

export interface AppMeta {
  name: string;
  title: string;
  repo: string;
  kind: "local" | "external";
  icon?: string;
  entry?: string;
  url?: string;
  dataRead: boolean;
  dataWrite: boolean;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Scan every root's apps/ dir; precedence-merge by name (later root wins). Invalid apps are skipped. */
export function listApps(roots: Root[]): AppMeta[] {
  const byName = new Map<string, AppMeta>();
  for (const root of roots) {
    const base = join(root.dir, "apps");
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (!NAME_RE.test(name)) continue;
      const meta = readAppMeta(root, name);
      if (meta) byName.set(name, meta); // last root wins → private overrides team overrides core
    }
  }
  return [...byName.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function readAppMeta(root: Root, name: string): AppMeta | undefined {
  const appDir = join(root.dir, "apps", name);
  const manifestPath = join(appDir, "app.json");
  if (!existsSync(manifestPath)) return undefined;
  let m: AppManifest;
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8")) as AppManifest;
  } catch {
    return undefined;
  }
  const title = (m.name ?? name).trim();
  const base: Omit<AppMeta, "kind" | "entry" | "url"> = {
    name,
    title,
    repo: root.name,
    ...(m.icon ? { icon: m.icon } : {}),
    dataRead: m.data?.read ?? false,
    dataWrite: m.data?.write ?? false,
  };
  if (m.kind === "external") {
    if (!m.url || !/^https?:\/\//.test(m.url)) return undefined; // drop non-http(s) (defends against team-synced/hand-edited manifests)
    return { ...base, kind: "external", url: m.url };
  }
  const entry = resolveEntry(appDir, m.entry);
  if (!entry) return undefined; // a local app must have an HTML entry
  return { ...base, kind: "local", entry };
}

/** manifest.entry (if it exists) → index.html → the shallowest *.html in the folder. */
function resolveEntry(appDir: string, declared?: string): string | undefined {
  if (declared && existsSync(join(appDir, declared))) return declared;
  if (existsSync(join(appDir, "index.html"))) return "index.html";
  const htmls = readdirSync(appDir).filter((f) => f.toLowerCase().endsWith(".html")).sort();
  return htmls[0];
}

/** Create/overwrite an app's app.json (+ optional starter index.html), path-guarded. */
export function writeAppManifest(
  roots: Root[],
  opts: { repo: string; name: string; manifest: AppManifest; starter?: string },
): { path: string } {
  if (!NAME_RE.test(opts.name)) throw new Error(`invalid app name (must be kebab-case): ${opts.name}`);
  const root = roots.find((r) => r.name === opts.repo);
  if (!root) throw new Error(`unknown repo: ${opts.repo}`);
  const appDir = join(root.dir, "apps", opts.name);
  // Defence in depth beyond NAME_RE: the dir's real location must stay inside <repo>/apps
  // (separator-safe + symlink-safe - lib/confine-path, the one shared implementation).
  if (confinePath(join(root.dir, "apps"), opts.name) === null) throw new Error(`app path escapes repo: ${opts.name}`);
  if (opts.manifest.kind === "external") {
    const url = opts.manifest.url;
    if (!url || typeof url !== "string" || !/^https?:\/\//.test(url)) {
      throw new Error("external app url must be an http(s) URL: " + (url || "(empty)"));
    }
  }
  mkdirSync(appDir, { recursive: true });
  const path = join(appDir, "app.json");
  writeFileSync(path, JSON.stringify(opts.manifest, null, 2) + "\n");
  if (opts.manifest.kind === "local" && opts.starter != null) writeFileSync(join(appDir, "index.html"), opts.starter);
  return { path };
}

/** Read one file inside an app folder, confined to `<repo>/apps/<name>/`. Used by the serve route. */
export function readAppFile(
  roots: Root[],
  repo: string,
  name: string,
  rel: string,
): { data: Buffer; ext: string } {
  if (!NAME_RE.test(name)) throw new Error(`invalid app name: ${name}`);
  const root = roots.find((r) => r.name === repo);
  if (!root) throw new Error(`unknown repo: ${repo}`);
  const appDir = resolve(root.dir, "apps", name);
  // Symlink-safe, separator-safe confinement to the app folder (canonicalizes BOTH sides - the
  // macOS /var alias trap) lives in lib/confine-path, the one shared implementation.
  const full = confinePath(appDir, rel);
  if (full === null) throw new Error(`path escapes app: ${rel}`);
  if (!existsSync(full)) throw new Error(`not found: ${rel}`);
  return { data: readFileSync(full), ext: extname(full).toLowerCase() };
}
