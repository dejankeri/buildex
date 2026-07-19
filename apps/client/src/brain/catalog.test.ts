import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync as ex, cpSync } from "node:fs";
import { listPacks, readPack, installPack, uninstallPack, packMcpProvider, type InstallDeps } from "./catalog.js";
import { bundleCatalogSource, type CatalogSource } from "./catalog-source.js";
import type { Root } from "./graph.js";

let dir: string;
let catalogDir: string;
let source: CatalogSource;
let roots: Root[];

/** Seed a pack DEFINITION into the (bundled) catalogue - the source of truth for what's available. */
function pack(id: string, manifest: unknown, skills: Record<string, string> = {}): void {
  const pdir = join(catalogDir, id);
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "pack.json"), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(skills)) {
    mkdirSync(join(pdir, "skills", name), { recursive: true });
    writeFileSync(join(pdir, "skills", name, "SKILL.md"), body);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-catalog-"));
  // Definitions live in a bundled catalogue, separate from the writable workspace roots (installed state).
  catalogDir = join(dir, "catalog");
  mkdirSync(catalogDir, { recursive: true });
  source = bundleCatalogSource(catalogDir);
  roots = [
    { name: "team", dir: join(dir, "team") },
    { name: "private", dir: join(dir, "private") },
  ];
  for (const r of roots) mkdirSync(r.dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("listPacks", () => {
  it("lists valid packs from the core catalog with derived faces", () => {
    pack("notion", {
      id: "notion", name: "Notion", icon: "🗒️", summary: "Docs.",
      app: { url: "https://www.notion.so" },
      mcp: { kind: "http", url: "https://mcp.notion.com/mcp" },
      skills: ["notion-search"],
    }, { "notion-search": "---\nname: notion-search\n---\n# Search" });
    const packs = listPacks(source, roots);
    expect(packs).toHaveLength(1);
    expect(packs[0]!.id).toBe("notion");
    expect(packs[0]!.faces).toEqual({ app: true, mcp: true, skills: 1 });
    expect(packs[0]!.installed).toBe(false);
  });

  it("skips packs with an invalid id, bad app url, or http mcp without url", () => {
    pack("bad-url", { id: "bad-url", name: "X", app: { url: "ftp://nope" } });
    pack("bad-mcp", { id: "bad-mcp", name: "Y", mcp: { kind: "http" } });
    writeFileSync(join(catalogDir, "bad-url", "pack.json"), "{ not json");
    expect(listPacks(source, roots)).toEqual([]);
  });

  it("marks installed (with installedIn) when a matching external app exists in a writable root", () => {
    pack("notion", { id: "notion", name: "Notion", app: { url: "https://www.notion.so" } });
    mkdirSync(join(dir, "team", "apps", "notion"), { recursive: true });
    writeFileSync(join(dir, "team", "apps", "notion", "app.json"),
      JSON.stringify({ kind: "external", url: "https://www.notion.so" }));
    const meta = listPacks(source, roots)[0]!;
    expect(meta.installed).toBe(true);
    expect(meta.installedIn).toBe("team");
  });

  it("drops a skill id that has no SKILL.md dir", () => {
    pack("x", { id: "x", name: "X", app: { url: "https://x.co" }, skills: ["ghost"] });
    expect(listPacks(source, roots)[0]!.faces.skills).toBe(0);
  });

  it("reads definitions LIVE from the source, never from the workspace roots (the staleness fix)", () => {
    pack("slack", { id: "slack", name: "Slack", app: { url: "https://slack.com" } });
    expect(listPacks(source, roots).map((p) => p.id)).toEqual(["slack"]);
    // A pack added to the catalogue after the first read is reflected immediately - no re-provisioning.
    pack("linear", { id: "linear", name: "Linear", app: { url: "https://linear.app" } });
    expect(listPacks(source, roots).map((p) => p.id)).toEqual(["linear", "slack"]);
    // Definitions never touch the workspace roots - no catalog/ dir is created there.
    expect(ex(join(dir, "team", "catalog"))).toBe(false);
    expect(ex(join(dir, "private", "catalog"))).toBe(false);
  });
});

describe("readPack", () => {
  it("returns the manifest for a known id, undefined otherwise", () => {
    pack("slack", { id: "slack", name: "Slack", app: { url: "https://slack.com" } });
    expect(readPack(source, "slack")?.name).toBe("Slack");
    expect(readPack(source, "nope")).toBeUndefined();
    expect(readPack(source, "../etc")).toBeUndefined();
  });
});

function deps(): InstallDeps & { pins: Record<string, unknown>; frags: string[] } {
  const pins: Record<string, unknown> = {};
  const frags: string[] = [];
  return {
    pins, frags,
    writeApp: (_r, o) => {
      const d = join(dir, o.repo, "apps", o.name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "app.json"), JSON.stringify(o.manifest));
    },
    copySkill: (src, destDir) => { mkdirSync(destDir, { recursive: true }); cpSync(src, destDir, { recursive: true }); },
    pinMcp: (key, cfg) => { pins[key] = cfg; },
    writePolicyFragment: (target, id, policy) => {
      const p = join(target, "policy", "packs", `${id}.json`);
      mkdirSync(join(target, "policy", "packs"), { recursive: true });
      writeFileSync(p, JSON.stringify(policy ?? {}));
      frags.push(p);
    },
  };
}

describe("installPack", () => {
  it("installs all present faces into the target root and reports them", () => {
    pack("notion", {
      id: "notion", name: "Notion",
      app: { url: "https://www.notion.so" },
      mcp: { kind: "http", url: "https://mcp.notion.com/mcp" },
      skills: ["notion-search"],
      policy: { allow: ["mcp__notion__search"], ask: ["mcp__notion__create_page"] },
    }, { "notion-search": "---\nname: notion-search\n---\n# Search" });
    const d = deps();
    const res = installPack(source, roots, { id: "notion", target: "team" }, d);
    expect(res.did).toEqual({ app: true, skills: ["notion-search"], mcp: true, policy: true });
    expect(ex(join(dir, "team", "apps", "notion", "app.json"))).toBe(true);
    expect(ex(join(dir, "team", "skills", "notion-search", "SKILL.md"))).toBe(true);
    expect(d.pins["buildex-pack:notion"]).toEqual({ type: "http", url: "https://mcp.notion.com/mcp" });
  });

  it("maps a stdio mcp face to a stdio pin config", () => {
    pack("loc", { id: "loc", name: "Loc", mcp: { kind: "stdio", command: "npx", args: ["-y", "@x/mcp"] } });
    const d = deps();
    installPack(source, roots, { id: "loc", target: "private" }, d);
    expect(d.pins["buildex-pack:loc"]).toEqual({ type: "stdio", command: "npx", args: ["-y", "@x/mcp"] });
  });

  it("writes an install marker (policy fragment) even for a pack with no policy - so app-less packs are detected", () => {
    pack("toolonly", { id: "toolonly", name: "ToolOnly", mcp: { kind: "http", url: "https://t.co/mcp" } });
    const d = deps();
    installPack(source, roots, { id: "toolonly", target: "team" }, d);
    expect(d.frags.some((f) => f.endsWith(`${"toolonly"}.json`))).toBe(true);
  });

  it("refuses to install into core", () => {
    pack("x", { id: "x", name: "X", app: { url: "https://x.co" } });
    expect(() => installPack(source, roots, { id: "x", target: "core" }, deps())).toThrow(/core/i);
  });

  it("throws on an unknown pack id", () => {
    expect(() => installPack(source, roots, { id: "ghost", target: "team" }, deps())).toThrow(/unknown/i);
  });

  it("uninstall removes app, skills, pin (null) and policy fragment", () => {
    pack("notion", { id: "notion", name: "Notion", app: { url: "https://www.notion.so" }, mcp: { kind: "http", url: "https://mcp.notion.com/mcp" }, skills: ["notion-search"] },
      { "notion-search": "---\nname: notion-search\n---\n# Search" });
    const d = deps();
    installPack(source, roots, { id: "notion", target: "team" }, d);
    const res = uninstallPack(source, roots, { id: "notion", target: "team" }, d);
    expect(res.did.mcp).toBe(true);
    expect(d.pins["buildex-pack:notion"]).toBeNull();
    expect(ex(join(dir, "team", "apps", "notion", "app.json"))).toBe(false);
    expect(ex(join(dir, "team", "skills", "notion-search"))).toBe(false);
  });
});

// Routing a pack's mcp face to the connector gateway vs keeping it a direct remote pin.
describe("packMcpProvider", () => {
  it("routes an http mcp pack to the gateway (name + url, scopes when given)", () => {
    expect(packMcpProvider({ id: "stripe", name: "Stripe", mcp: { kind: "http", url: "https://mcp.stripe.com" } }))
      .toEqual({ name: "stripe", url: "https://mcp.stripe.com" });
    expect(packMcpProvider({ id: "x", name: "X", mcp: { kind: "http", url: "https://x/mcp", scopes: ["read"] } }))
      .toEqual({ name: "x", url: "https://x/mcp", scopes: ["read"] });
  });
  it("keeps a `direct` (non-DCR) provider off the gateway - stays a remote pin", () => {
    expect(packMcpProvider({ id: "gmail", name: "Gmail", mcp: { kind: "http", url: "https://gmailmcp.googleapis.com/mcp/v1", direct: true } }))
      .toBeNull();
  });
  it("returns null for a stdio (local) mcp or no mcp face", () => {
    expect(packMcpProvider({ id: "loc", name: "Loc", mcp: { kind: "stdio", command: "npx" } })).toBeNull();
    expect(packMcpProvider({ id: "appless", name: "Appless", app: { url: "https://a" } })).toBeNull();
  });
});

// The install target is a *slot* - "team" | "private" - not a literal repo name. The repo names can
// be company-suffixed (the demo seeds "team-acme"/"private-you"; a synced account may name the team
// brain after the company). The write path must resolve the slot to the writable root, mirroring the
// read side (installedIn is documented as team|private). Regression for "unknown target root: team".
describe("slot → writable-root resolution (company-suffixed names)", () => {
  function demoRoots(): Root[] {
    const rs: Root[] = [
      { name: "core", dir: join(dir, "core") },
      { name: "team-acme", dir: join(dir, "team-acme") },
      { name: "private-you", dir: join(dir, "private-you") },
    ];
    for (const r of rs) mkdirSync(r.dir, { recursive: true });
    return rs;
  }

  it("installs the 'team' slot into the team-* writable root", () => {
    const rs = demoRoots();
    pack("notion", { id: "notion", name: "Notion", app: { url: "https://www.notion.so" }, skills: ["notion-search"] },
      { "notion-search": "---\nname: notion-search\n---\n# Search" });
    const d = deps();
    const res = installPack(source, rs, { id: "notion", target: "team" }, d);
    expect(res.target).toBe("team-acme");
    expect(ex(join(dir, "team-acme", "apps", "notion", "app.json"))).toBe(true);
    expect(ex(join(dir, "team-acme", "skills", "notion-search", "SKILL.md"))).toBe(true);
  });

  it("installs the 'private' slot into the private-* writable root", () => {
    const rs = demoRoots();
    pack("loc", { id: "loc", name: "Loc", mcp: { kind: "stdio", command: "npx", args: ["-y", "@x/mcp"] } });
    const d = deps();
    const res = installPack(source, rs, { id: "loc", target: "private" }, d);
    expect(res.target).toBe("private-you");
    expect(d.pins["buildex-pack:loc"]).toEqual({ type: "stdio", command: "npx", args: ["-y", "@x/mcp"] });
  });

  it("reports installedIn as the slot ('team'), not the raw repo name", () => {
    const rs = demoRoots();
    pack("notion", { id: "notion", name: "Notion", app: { url: "https://www.notion.so" } });
    installPack(source, rs, { id: "notion", target: "team" }, deps());
    const meta = listPacks(source, rs).find((p) => p.id === "notion")!;
    expect(meta.installed).toBe(true);
    expect(meta.installedIn).toBe("team");
  });

  it("uninstalls via the slot round-trip from installedIn", () => {
    const rs = demoRoots();
    pack("notion", { id: "notion", name: "Notion", app: { url: "https://www.notion.so" }, skills: ["notion-search"] },
      { "notion-search": "---\nname: notion-search\n---\n# Search" });
    const d = deps();
    installPack(source, rs, { id: "notion", target: "team" }, d);
    const slot = listPacks(source, rs).find((p) => p.id === "notion")!.installedIn!;
    uninstallPack(source, rs, { id: "notion", target: slot }, d);
    expect(ex(join(dir, "team-acme", "apps", "notion", "app.json"))).toBe(false);
    expect(d.pins["buildex-pack:notion"]).toBeNull();
  });
});
