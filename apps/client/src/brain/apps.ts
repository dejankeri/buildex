// The Apps surface (plus the external-app extension). An app is a folder `<root>/apps/<name>/`
// with an app.json manifest, resolved across roots with precedence private>team>core - the same
// model as brain/skills.ts. A `local` app ships HTML run in an opaque-origin sandbox; an
// `external` app is a remote URL embedded in a webview. This module is the deterministic catalog
// (invariant 9 - rendered from repo state, zero LLM) plus the path-confined create/read surface.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { confinePath } from "../lib/confine-path.js";
import type { Root } from "./graph.js";

/** One brokered secret slot a local app declares. The VALUE never appears in the manifest (or any
 *  repo file) - it lives in the keychain and the daemon attaches it per request (invariant 4). */
export interface AppSecretSpec {
  /** The slot name (kebab-case, like app names) - the keychain key is derived from it. */
  name: string;
  /** The request header the daemon attaches the value under. Absent → `Authorization: Bearer <value>`. */
  header?: string;
}

export interface AppManifest {
  name?: string;
  icon?: string;
  kind: "local" | "external";
  entry?: string;
  url?: string;
  /** Deferred widening seam - NOT honored today (invariant 10): a local app's brokered reads are
   *  always confined to its own folder, whatever these flags say. A future explicit-grant flow (an
   *  operator tap, not a manifest bit an app author sets on itself) is the only thing that may widen. */
  data?: { read?: boolean; write?: boolean };
  /** The https origins this app may reach: they become the served document's connect-src AND the
   *  allowlist for brokered fetches. Nothing declared → egress closed (daemon origin only). */
  origins?: string[];
  /** The brokered secret slots this app may use (see AppSecretSpec). */
  secrets?: AppSecretSpec[];
}

export interface AppMeta {
  name: string;
  title: string;
  repo: string;
  kind: "local" | "external";
  icon?: string;
  entry?: string;
  url?: string;
  /** Validated egress origins (invalid declarations are dropped, never fixed up). */
  origins: string[];
  /** Validated secret slots. */
  secrets: AppSecretSpec[];
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
// A declared egress origin: https, an optional single leading subdomain wildcard, a host (optional
// port), and nothing else - no path/query, no credentials, no broader wildcards. Anything that
// doesn't match is dropped at read time (fail-closed), the same posture as the external-url guard.
const ORIGIN_RE = /^https:\/\/(\*\.)?[a-z0-9][a-z0-9.-]*(:\d{1,5})?$/;
// An HTTP header NAME (token) - the daemon puts a secret under it, so it must be shape-checked.
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

/** Keep only well-formed origin declarations (defends against team-synced/hand-edited manifests). */
function validOrigins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((o): o is string => typeof o === "string" && ORIGIN_RE.test(o));
}

/** Keep only well-formed secret slots - a bad name or header drops the slot, never "fixes" it. */
function validSecrets(raw: unknown): AppSecretSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: AppSecretSpec[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) continue;
    const { name, header } = s as { name?: unknown; header?: unknown };
    if (typeof name !== "string" || !NAME_RE.test(name)) continue;
    if (header !== undefined && (typeof header !== "string" || !HEADER_RE.test(header))) continue;
    out.push({ name, ...(header ? { header } : {}) });
  }
  return out;
}

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
    origins: validOrigins(m.origins),
    secrets: validSecrets(m.secrets),
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

/** A local app's own folder (the one holding its manifest) plus its validated declared grants - the
 *  single lookup the data broker, the fetch broker and the serve route share. An app's authority is
 *  exactly this: its own files, its declared origins, its declared secret slots. undefined for an
 *  unknown repo/name, a non-local app, or an invalid manifest (fail-closed). */
export function appGrants(
  roots: Root[],
  repo: string,
  name: string,
): { appDir: string; origins: string[]; secrets: AppSecretSpec[] } | undefined {
  if (!NAME_RE.test(name)) return undefined;
  const root = roots.find((r) => r.name === repo);
  if (!root) return undefined;
  const meta = readAppMeta(root, name);
  if (!meta || meta.kind !== "local") return undefined;
  return { appDir: join(root.dir, "apps", name), origins: meta.origins, secrets: meta.secrets };
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
