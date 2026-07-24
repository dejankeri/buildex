import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listApps, writeAppManifest, readAppFile, appGrants } from "./apps.js";
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
  it("lists a local app with a resolved entry and closed-by-default grants", () => {
    seedApp("team", "crm-demo", { name: "CRM Demo", icon: "🧪", kind: "local" }, { "index.html": "<h1>hi</h1>" });
    const apps = listApps(roots);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ name: "crm-demo", title: "CRM Demo", repo: "team", kind: "local", entry: "index.html", origins: [], secrets: [] });
  });

  it("keeps well-formed origin/secret declarations and drops malformed ones (fail-closed)", () => {
    seedApp("team", "crm-demo", {
      name: "CRM Demo",
      kind: "local",
      origins: [
        "https://api.example.com",          // exact origin - kept
        "https://*.example.com",            // leading subdomain wildcard - kept
        "https://api.example.com:8443",     // explicit port - kept
        "http://api.example.com",           // not https - dropped
        "https://api.example.com/v1",       // a path is not an origin - dropped
        "https://*",                        // a bare wildcard grants everything - dropped
        "https://api.*.example.com",        // wildcard not leading - dropped
        42,                                 // not even a string - dropped
      ],
      secrets: [
        { name: "api-key" },                          // kept, default header
        { name: "api-key-2", header: "X-Api-Key" },   // kept, custom header
        { name: "Bad Name" },                         // not kebab-case - dropped
        { name: "bad-header", header: "X: evil" },    // not a header token - dropped
        "api-key-3",                                  // not an object - dropped
      ],
    }, { "index.html": "x" });
    const app = listApps(roots)[0]!;
    expect(app.origins).toEqual(["https://api.example.com", "https://*.example.com", "https://api.example.com:8443"]);
    expect(app.secrets).toEqual([{ name: "api-key" }, { name: "api-key-2", header: "X-Api-Key" }]);
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

  it("appGrants resolves a local app's own folder + validated grants, and nothing else", () => {
    seedApp("team", "crm-demo", { name: "CRM", kind: "local", origins: ["https://api.example.com"], secrets: [{ name: "api-key" }] }, { "index.html": "x" });
    seedApp("team", "ext", { name: "Ext", kind: "external", url: "https://app.example.com" });
    const g = appGrants(roots, "team", "crm-demo");
    expect(g).toMatchObject({ appDir: join(dir, "team", "apps", "crm-demo"), origins: ["https://api.example.com"], secrets: [{ name: "api-key" }] });
    expect(appGrants(roots, "team", "ext")).toBeUndefined(); // external apps have no local folder to serve
    expect(appGrants(roots, "team", "nope")).toBeUndefined();
    expect(appGrants(roots, "nope", "crm-demo")).toBeUndefined();
    expect(appGrants(roots, "team", "../crm-demo")).toBeUndefined(); // name is shape-checked, not joined
  });

  it("writes and lists a valid https external app", () => {
    writeAppManifest(roots, { repo: "team", name: "good-ext", manifest: { name: "Good", kind: "external", url: "https://example.com" } });
    const apps = listApps(roots);
    expect(apps.map((a) => a.name)).toContain("good-ext");
    expect(apps.find((a) => a.name === "good-ext")!).toMatchObject({ kind: "external", url: "https://example.com" });
  });
});
