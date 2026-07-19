import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listApps, writeAppManifest, readAppFile } from "./apps.js";
import type { Root } from "./graph.js";

let dir: string;
let roots: Root[];

function seedApp(repo: string, name: string, manifest: object, files: Record<string, string> = {}) {
  const appDir = join(dir, repo, "apps", name);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "app.json"), JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(appDir, rel), body);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-apps-"));
  mkdirSync(join(dir, "core"));
  mkdirSync(join(dir, "team"));
  mkdirSync(join(dir, "private"));
  roots = [
    { name: "core", dir: join(dir, "core") },
    { name: "team", dir: join(dir, "team") },
    { name: "private", dir: join(dir, "private") },
  ];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("listApps - the Apps surface catalog", () => {
  it("lists a local app with a resolved entry and read flag", () => {
    seedApp("team", "crm-demo", { name: "CRM Demo", icon: "🧪", kind: "local", data: { read: true } }, { "index.html": "<h1>hi</h1>" });
    const apps = listApps(roots);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ name: "crm-demo", title: "CRM Demo", repo: "team", kind: "local", entry: "index.html", dataRead: true, dataWrite: false });
  });

  it("lists an external app carrying its url and no entry", () => {
    seedApp("team", "protocol", { name: "Protocol", icon: "🌐", kind: "external", url: "https://app.protocolcrm.com" });
    const apps = listApps(roots);
    expect(apps[0]).toMatchObject({ name: "protocol", kind: "external", url: "https://app.protocolcrm.com" });
    expect(apps[0]!.entry).toBeUndefined();
  });

  it("skips a local folder with no HTML entry and an external folder with no url", () => {
    seedApp("team", "broken-local", { name: "Broken", kind: "local" });
    seedApp("team", "broken-ext", { name: "BrokenExt", kind: "external" });
    expect(listApps(roots)).toHaveLength(0);
  });

  it("resolves precedence: a private app overrides a same-named team app", () => {
    seedApp("team", "dash", { name: "Team Dash", kind: "local" }, { "index.html": "team" });
    seedApp("private", "dash", { name: "My Dash", kind: "local" }, { "index.html": "mine" });
    const apps = listApps(roots);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ title: "My Dash", repo: "private" });
  });

  it("falls back entry to index.html then the shallowest .html", () => {
    seedApp("team", "a", { name: "A", kind: "local", entry: "main.html" }, { "main.html": "x", "index.html": "y" });
    seedApp("team", "b", { name: "B", kind: "local" }, { "page.html": "z" });
    const byName = Object.fromEntries(listApps(roots).map((a) => [a.name, a]));
    expect(byName["a"]!.entry).toBe("main.html");
    expect(byName["b"]!.entry).toBe("page.html");
  });

  it("drops an external app whose hand-edited/synced url is not http(s) (read-time guard)", () => {
    seedApp("team", "evil", { name: "Evil", kind: "external", url: "javascript:alert(1)" });
    expect(listApps(roots)).toHaveLength(0);
  });
});

describe("writeAppManifest + readAppFile - create and path-confined read", () => {
  it("writes a manifest (and starter) then reads the entry back", () => {
    writeAppManifest(roots, { repo: "private", name: "hello", manifest: { name: "Hello", kind: "local", data: { read: true } }, starter: "<h1>Hello</h1>" });
    const apps = listApps(roots);
    expect(apps.map((a) => a.name)).toContain("hello");
    const f = readAppFile(roots, "private", "hello", "index.html");
    expect(f.data.toString()).toBe("<h1>Hello</h1>");
    expect(f.ext).toBe(".html");
  });

  it("rejects a name that is not kebab-case", () => {
    expect(() => writeAppManifest(roots, { repo: "team", name: "Bad Name", manifest: { name: "x", kind: "local" } })).toThrow(/kebab/i);
  });

  it("refuses a traversal path in readAppFile", () => {
    seedApp("team", "safe", { name: "Safe", kind: "local" }, { "index.html": "ok" });
    expect(() => readAppFile(roots, "team", "safe", "../../secret")).toThrow(/escapes|invalid/i);
  });

  it("rejects an external app whose url is not http(s)", () => {
    expect(() =>
      writeAppManifest(roots, { repo: "team", name: "bad-ext", manifest: { name: "Bad", kind: "external", url: "javascript:alert(1)" } }),
    ).toThrow(/http\(s\)|url/i);
  });

  it("writes and lists a valid https external app", () => {
    writeAppManifest(roots, { repo: "team", name: "good-ext", manifest: { name: "Good", kind: "external", url: "https://example.com" } });
    const apps = listApps(roots);
    expect(apps.map((a) => a.name)).toContain("good-ext");
    expect(apps.find((a) => a.name === "good-ext")!).toMatchObject({ kind: "external", url: "https://example.com" });
  });
});
