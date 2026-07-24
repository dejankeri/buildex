// Serving + data-brokering for LOCAL apps. The serve route is path-confined to <repo>/apps/<name>/
// and injects the bridge into HTML; the data broker resolves reads inside the app's OWN folder only
// - an app's authority is its own files, never the workspace (no secret, and no other repo content,
// ever crosses into the sandbox). Writes are refused in v1 (fast-follow).
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { confinePath } from "../lib/confine-path.js";
import type { Root } from "../brain/graph.js";
import { readAppFile, appGrants } from "../brain/apps.js";
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

/** The CSP for a served app DOCUMENT. `sandbox` forces an opaque origin even on direct navigation /
 *  window.open (mirrors the iframe `sandbox` attribute); `connect-src` closes egress by default -
 *  the document can fetch/XHR/WebSocket only the daemon itself ('self', which keeps the app bridge
 *  working) plus whatever https origins its manifest declares. Do NOT add default-src/script-src:
 *  local apps load their own bundled css/js/images via relative URLs and that would break them. */
export function appCsp(origins: string[]): string {
  return ["sandbox allow-scripts allow-forms allow-popups", ["connect-src 'self'", ...origins].join(" ")].join("; ");
}

/** Resolve GET /apps-serve/<repo>/<name>/<rel...> to a body + content-type (+ the document CSP for
 *  HTML), or null if unresolvable. */
export function serveApp(
  roots: Root[],
  urlPath: string,
): { body: Buffer | string; contentType: string; csp?: string } | null {
  const m = urlPath.match(/^\/apps-serve\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, repo, name, rel] = m;
  const repoName = decodeURIComponent(repo!);
  const appName = decodeURIComponent(name!);
  let file: { data: Buffer; ext: string };
  try {
    file = readAppFile(roots, repoName, appName, decodeURIComponent(rel!));
  } catch {
    return null; // traversal, unknown repo, or missing file → not served
  }
  const contentType = CONTENT_TYPES[file.ext] ?? "application/octet-stream";
  if (file.ext === ".html") {
    // The manifest's (validated) origins widen connect-src; no manifest grants → daemon origin only.
    const grants = appGrants(roots, repoName, appName);
    return { body: injectBridge(file.data.toString("utf8")), contentType, csp: appCsp(grants?.origins ?? []) };
  }
  return { body: file.data, contentType };
}

/** Broker a data op for an app: read/list resolve INSIDE the app's own folder only (the folder that
 *  holds its manifest); write is refused (403) in v1. The manifest's data.read flag never widens
 *  this - only a future explicit operator grant may (see AppManifest.data). */
export function brokerData(
  roots: Root[],
  reqBody: { op: "read" | "list" | "write"; repo: string; name: string; path?: string; glob?: string },
): { ok: boolean; result?: unknown; error?: string; status: number } {
  const grants = appGrants(roots, reqBody.repo, reqBody.name);
  if (!grants) return { ok: false, error: `unknown app: ${reqBody.name}`, status: 404 };
  if (reqBody.op === "write") return { ok: false, error: "buildex.write is not yet enabled (deferred)", status: 403 };
  if (reqBody.op === "read") {
    // Symlink-safe, separator-safe confinement to the app's own folder (canonicalizes BOTH sides -
    // the macOS /var alias trap) lives in lib/confine-path, the one shared implementation. A miss
    // and an escape are indistinguishable on purpose - the answer is the same 404 either way.
    const full = confinePath(grants.appDir, reqBody.path ?? "");
    if (full === null || !existsSync(full) || !statSync(full).isFile()) {
      return { ok: false, error: "path not found in the app's own folder", status: 404 };
    }
    return { ok: true, result: readFileSync(full, "utf8"), status: 200 };
  }
  if (reqBody.op === "list") {
    // Minimal v1: list the files of the app's own folder (glob matching is a fast-follow).
    const out: string[] = [];
    collectFiles(grants.appDir, grants.appDir, out);
    return { ok: true, result: out, status: 200 };
  }
  return { ok: false, error: "unknown op", status: 400 };
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
