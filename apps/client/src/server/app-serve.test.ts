import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveApp, brokerData, appCsp } from "./app-serve.js";
import { injectBridge, APP_BRIDGE } from "./app-bridge.js";
import type { Root } from "../brain/graph.js";

// Escaping DIRECTORY link via each platform's real, unprivileged primitive: a junction on Windows
// (skills are materialized as junctions - the actual Windows attack surface - needing no elevation),
// a POSIX symlink elsewhere.
function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : undefined);
}

let dir: string;
let roots: Root[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-serve-"));
  const appDir = join(dir, "team", "apps", "crm-demo");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "app.json"), JSON.stringify({ name: "CRM", kind: "local" }));
  writeFileSync(join(appDir, "index.html"), "<head></head><body><h1>hi</h1></body>");
  writeFileSync(join(appDir, "app.js"), "console.log(1)");
  mkdirSync(join(appDir, "data"), { recursive: true });
  writeFileSync(join(appDir, "data", "rows.json"), "[1,2]");
  writeFileSync(join(dir, "team", "notes.md"), "# team notes");
  roots = [{ name: "team", dir: join(dir, "team") }];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("injectBridge", () => {
  it("inserts the bridge script right after <head>", () => {
    const out = injectBridge("<head></head><body>x</body>");
    expect(out.indexOf(APP_BRIDGE)).toBeGreaterThan(-1);
    expect(out.indexOf(APP_BRIDGE)).toBeLessThan(out.indexOf("<body>"));
  });
});

describe("serveApp - path-confined serving with bridge injection", () => {
  it("serves the HTML entry with the bridge injected and egress closed by default", () => {
    const r = serveApp(roots, "/apps-serve/team/crm-demo/index.html");
    expect(r).not.toBeNull();
    expect(r!.contentType).toMatch(/text\/html/);
    expect(String(r!.body)).toContain(APP_BRIDGE);
    expect(String(r!.body)).toContain("<h1>hi</h1>");
    // No manifest origins → the document may only reach the daemon itself.
    expect(r!.csp).toBe("sandbox allow-scripts allow-forms allow-popups; connect-src 'self'");
  });

  it("widens connect-src to exactly the manifest's validated origins", () => {
    const appDir = join(dir, "team", "apps", "crm-demo");
    writeFileSync(join(appDir, "app.json"), JSON.stringify({
      name: "CRM", kind: "local",
      origins: ["https://api.example.com", "https://*.example.org", "http://sneaky.example.com"],
    }));
    const r = serveApp(roots, "/apps-serve/team/crm-demo/index.html");
    expect(r!.csp).toBe(
      "sandbox allow-scripts allow-forms allow-popups; connect-src 'self' https://api.example.com https://*.example.org",
    );
  });

  it("serves a js asset verbatim (no bridge, no document CSP)", () => {
    const r = serveApp(roots, "/apps-serve/team/crm-demo/app.js");
    expect(r!.contentType).toMatch(/javascript/);
    expect(String(r!.body)).toBe("console.log(1)");
    expect(r!.csp).toBeUndefined();
  });

  it("refuses traversal outside the app folder", () => {
    expect(serveApp(roots, "/apps-serve/team/crm-demo/../../notes.md")).toBeNull();
  });

  // A FILE symlink can't be created unprivileged on Windows, and a junction is directory-only - so
  // there's no unprivileged way to build this file-symlink case there; the escaping-file read is
  // still covered on Windows by the junctioned-directory variant below.
  it.skipIf(process.platform === "win32")("refuses a symlink inside the app folder that points outside the workspace roots", () => {
    // A file that lives entirely outside any workspace root (a separate temp dir).
    const outsideDir = mkdtempSync(join(tmpdir(), "buildex-outside-"));
    const secretPath = join(outsideDir, "secret.txt");
    writeFileSync(secretPath, "top secret");
    const appDir = join(dir, "team", "apps", "crm-demo");
    symlinkSync(secretPath, join(appDir, "leak.txt"));
    try {
      expect(serveApp(roots, "/apps-serve/team/crm-demo/leak.txt")).toBeNull();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses a file read THROUGH a directory link inside the app folder that escapes the workspace roots", () => {
    // The escaping vector expressed with a directory link (junction on Windows): the app folder holds
    // a link to a dir outside every root, and the requested file lives inside it.
    const outsideDir = mkdtempSync(join(tmpdir(), "buildex-outside-"));
    writeFileSync(join(outsideDir, "secret.txt"), "top secret");
    const appDir = join(dir, "team", "apps", "crm-demo");
    linkDir(outsideDir, join(appDir, "leak"));
    try {
      expect(serveApp(roots, "/apps-serve/team/crm-demo/leak/secret.txt")).toBeNull();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("brokerData - read/list confined to the app's own folder, write refused in v1", () => {
  const asApp = { repo: "team", name: "crm-demo" };

  it("reads a file inside the app's own folder", () => {
    const r = brokerData(roots, { op: "read", ...asApp, path: "data/rows.json" });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(r.result).toBe("[1,2]");
  });

  it("refuses a read of a workspace file OUTSIDE the app's own folder", () => {
    // notes.md sits at the root of the same repo - an app has no claim on it.
    const r = brokerData(roots, { op: "read", ...asApp, path: "notes.md" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it("lists only the app's own files", () => {
    const r = brokerData(roots, { op: "list", ...asApp });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect((r.result as string[]).sort()).toEqual(["app.js", "app.json", join("data", "rows.json"), "index.html"]);
  });

  it("ignores a manifest data.read flag - the app author cannot widen their own scope", () => {
    const appDir = join(dir, "team", "apps", "crm-demo");
    writeFileSync(join(appDir, "app.json"), JSON.stringify({ name: "CRM", kind: "local", data: { read: true } }));
    const r = brokerData(roots, { op: "read", ...asApp, path: "notes.md" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it("refuses a write with 403", () => {
    const r = brokerData(roots, { op: "write", ...asApp, path: "data/rows.json" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/not.*enabled|deferred/i);
  });

  it("refuses a traversal read (indistinguishable from a miss)", () => {
    const r = brokerData(roots, { op: "read", ...asApp, path: "../../notes.md" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it("refuses ops for an unknown app", () => {
    const r = brokerData(roots, { op: "read", repo: "team", name: "nope", path: "index.html" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });
});

describe("appCsp", () => {
  it("always includes 'self' so the bridge keeps working, then the declared origins verbatim", () => {
    expect(appCsp([])).toContain("connect-src 'self'");
    expect(appCsp(["https://a.example.com"])).toBe(
      "sandbox allow-scripts allow-forms allow-popups; connect-src 'self' https://a.example.com",
    );
  });
});
