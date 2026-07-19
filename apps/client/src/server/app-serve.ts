// Serving + data-brokering for LOCAL apps. The serve route is path-confined to <repo>/apps/<name>/
// and injects the bridge into HTML; the data broker resolves reads against the workspace roots
// server-side (no secret ever crosses into the sandbox). Writes are refused in v1 (fast-follow).
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { confinePath } from "../lib/confine-path.js";
import type { Root } from "../brain/graph.js";
import { readAppFile } from "../brain/apps.js";
import { injectBridge } from "./app-bridge.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

/** Resolve GET /apps-serve/<repo>/<name>/<rel...> to a body + content-type, or null if unresolvable. */
export function serveApp(roots: Root[], urlPath: string): { body: Buffer | string; contentType: string } | null {
  const m = urlPath.match(/^\/apps-serve\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, repo, name, rel] = m;
  let file: { data: Buffer; ext: string };
  try {
    file = readAppFile(roots, decodeURIComponent(repo!), decodeURIComponent(name!), decodeURIComponent(rel!));
  } catch {
    return null; // traversal, unknown repo, or missing file → not served
  }
  const contentType = CONTENT_TYPES[file.ext] ?? "application/octet-stream";
  if (file.ext === ".html") return { body: injectBridge(file.data.toString("utf8")), contentType };
  return { body: file.data, contentType };
}

/** Broker a data op for an app: read/list resolve within roots; write is refused (403) in v1. */
export function brokerData(
  roots: Root[],
  reqBody: { op: "read" | "list" | "write"; path?: string; glob?: string },
): { ok: boolean; result?: unknown; error?: string; status: number } {
  if (reqBody.op === "write") return { ok: false, error: "buildex.write is not yet enabled (deferred)", status: 403 };
  if (reqBody.op === "read") {
    const hit = resolveInRoots(roots, reqBody.path ?? "");
    if (!hit) return { ok: false, error: "path not found or escapes workspace", status: 400 };
    return { ok: true, result: readFileSync(hit, "utf8"), status: 200 };
  }
  if (reqBody.op === "list") {
    // Minimal v1: list top-level files across roots (glob matching is a fast-follow).
    const out: string[] = [];
    for (const r of roots) collectFiles(r.dir, r.dir, out);
    return { ok: true, result: out, status: 200 };
  }
  return { ok: false, error: "unknown op", status: 400 };
}

/** Resolve a workspace-relative path against roots (precedence: later root wins), confined per root. */
function resolveInRoots(roots: Root[], rel: string): string | undefined {
  let hit: string | undefined;
  for (const r of roots) {
    // Symlink-safe, separator-safe confinement (canonicalizes BOTH sides - the macOS /var alias
    // trap) lives in lib/confine-path, the one shared implementation.
    const full = confinePath(r.dir, rel);
    if (full === null || !existsSync(full) || !statSync(full).isFile()) continue;
    hit = full;
  }
  return hit;
}

function collectFiles(base: string, cur: string, out: string[], depth = 0): void {
  if (depth > 4) return;
  for (const e of readdirSync(cur, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = join(cur, e.name);
    if (e.isDirectory()) collectFiles(base, full, out, depth + 1);
    else out.push(full.slice(base.length + 1));
  }
}
