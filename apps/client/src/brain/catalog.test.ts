import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync as ex, cpSync, readFileSync } from "node:fs";
import { listPacks, readPack, installPack, uninstallPack, packMcpProvider, packApiKeyPin, apiKeyKeychainKey, type InstallDeps } from "./catalog.js";
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
    expect(packs[0]!.faces).toEqual({ app: true, mcp: true, apiKey: false, provision: false, sandbox: false, skills: 1 });
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
    // Mirrors wiring.ts: a null policy REMOVES the fragment (that is how uninstall drops the
    // install marker). Writing `{}` for null here would quietly leave every pack looking installed.
    writePolicyFragment: (target, id, policy) => {
      const p = join(target, "policy", "packs", `${id}.json`);
      if (policy == null) { if (ex(p)) rmSync(p); return; }
      mkdirSync(join(target, "policy", "packs"), { recursive: true });
      writeFileSync(p, JSON.stringify(policy));
      frags.push(p);
    },
  };
}

/** Read a written JSON file back (the fragment/manifest assertions below). */
function rd(p: string): unknown { return JSON.parse(readFileSync(p, "utf8")); }

describe("installPack — the app face is the operator's, the rules are the company's", () => {
  it("splits the faces: app + install marker to private, skills + policy to team", () => {
    pack("notion", {
      id: "notion", name: "Notion",
      app: { url: "https://www.notion.so" },
      mcp: { kind: "http", url: "https://mcp.notion.com/mcp" },
      skills: ["notion-search"],
      policy: { allow: ["mcp__notion__search"], ask: ["mcp__notion__create_page"] },
    }, { "notion-search": "---\nname: notion-search\n---\n# Search" });
    const d = deps();
    const res = installPack(source, roots, { id: "notion" }, d);
    expect(res.did).toEqual({ app: true, skills: ["notion-search"], mcp: true, policy: true });
    expect(res.target).toBe("private");
    expect(res.rulesTarget).toBe("team");
    // Yours: the app in your rail.
    expect(ex(join(dir, "private", "apps", "notion", "app.json"))).toBe(true);
    expect(ex(join(dir, "team", "apps", "notion", "app.json"))).toBe(false);
    // The company's: how this company uses Notion, and what Notion may do here.
    expect(ex(join(dir, "team", "skills", "notion-search", "SKILL.md"))).toBe(true);
    expect(ex(join(dir, "private", "skills", "notion-search"))).toBe(false);
    expect(rd(join(dir, "team", "policy", "packs", "notion.json"))).toEqual({ allow: ["mcp__notion__search"], ask: ["mcp__notion__create_page"] });
    // The private fragment is a bare install marker — never a second, per-operator copy of the rules.
    expect(rd(join(dir, "private", "policy", "packs", "notion.json"))).toEqual({});
    expect(d.pins["buildex-pack:notion"]).toEqual({ type: "http", url: "https://mcp.notion.com/mcp" });
  });

  it("keeps the real policy hints when the workspace has no team root (rules fall back to private)", () => {
    pack("solo", { id: "solo", name: "Solo", mcp: { kind: "http", url: "https://s.co/mcp" }, policy: { ask: ["mcp__solo__send"] } });
    const soloRoots = roots.filter((r) => r.name !== "team");
    const d = deps();
    const res = installPack(source, soloRoots, { id: "solo" }, d);
    expect(res.rulesTarget).toBe("private");
    // The marker write must NOT clobber the hints when both land in the same file.
    expect(rd(join(dir, "private", "policy", "packs", "solo.json"))).toEqual({ ask: ["mcp__solo__send"] });
  });

  it("maps a stdio mcp face to a stdio pin config", () => {
    pack("loc", { id: "loc", name: "Loc", mcp: { kind: "stdio", command: "npx", args: ["-y", "@x/mcp"] } });
    const d = deps();
    installPack(source, roots, { id: "loc" }, d);
    expect(d.pins["buildex-pack:loc"]).toEqual({ type: "stdio", command: "npx", args: ["-y", "@x/mcp"] });
  });

  it("writes the private install marker even for a pack with no policy - so app-less packs are detected", () => {
    pack("toolonly", { id: "toolonly", name: "ToolOnly", mcp: { kind: "http", url: "https://t.co/mcp" } });
    const d = deps();
    installPack(source, roots, { id: "toolonly" }, d);
    expect(ex(join(dir, "private", "policy", "packs", "toolonly.json"))).toBe(true);
    expect(listPacks(source, roots).find((p) => p.id === "toolonly")!.installed).toBe(true);
  });

  it("throws on an unknown pack id", () => {
    expect(() => installPack(source, roots, { id: "ghost" }, deps())).toThrow(/unknown/i);
  });

  it("uninstall clears the operator's app + pin, and LEAVES the company rules standing", () => {
    pack("notion", { id: "notion", name: "Notion", app: { url: "https://www.notion.so" }, mcp: { kind: "http", url: "https://mcp.notion.com/mcp" }, skills: ["notion-search"], policy: { ask: ["mcp__notion__create_page"] } },
      { "notion-search": "---\nname: notion-search\n---\n# Search" });
    const d = deps();
    installPack(source, roots, { id: "notion" }, d);
    const res = uninstallPack(source, roots, { id: "notion", target: "private" }, d);
    expect(res.did.mcp).toBe(true);
    expect(d.pins["buildex-pack:notion"]).toBeNull();
    expect(ex(join(dir, "private", "apps", "notion", "app.json"))).toBe(false);
    expect(ex(join(dir, "private", "policy", "packs", "notion.json"))).toBe(false); // marker gone
    expect(listPacks(source, roots).find((p) => p.id === "notion")!.installed).toBe(false);
    // Untouched: other people may be working against these, and one person leaving must not
    // silently change what the company allows.
    expect(ex(join(dir, "team", "skills", "notion-search", "SKILL.md"))).toBe(true);
    expect(rd(join(dir, "team", "policy", "packs", "notion.json"))).toEqual({ ask: ["mcp__notion__create_page"] });
  });

  it("a teammate's company rules alone do NOT read as installed on this machine", () => {
    pack("linear", { id: "linear", name: "Linear", mcp: { kind: "http", url: "https://mcp.linear.app" }, policy: { ask: ["mcp__linear__create_issue"] } });
    // Exactly what syncing down a colleague's install leaves behind: team rules, no private marker.
    mkdirSync(join(dir, "team", "policy", "packs"), { recursive: true });
    writeFileSync(join(dir, "team", "policy", "packs", "linear.json"), JSON.stringify({ ask: ["mcp__linear__create_issue"] }));
    const meta = listPacks(source, roots).find((p) => p.id === "linear")!;
    expect(meta.installed).toBe(false);
    expect(meta.installedIn).toBeUndefined();
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

// API-key mode: a stored `mcp-bearer` key overrides OAuth by header-injecting the pack's own MCP url.
describe("packApiKeyPin", () => {
  const reader = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
  const stripe = { id: "stripe", name: "Stripe", mcp: { kind: "http" as const, url: "https://mcp.stripe.com" }, apiKey: { transport: "mcp-bearer" as const, docsUrl: "https://x" } };

  it("injects the stored key as a Bearer header on the mcp url", () => {
    expect(packApiKeyPin(stripe, reader({ [apiKeyKeychainKey("stripe")]: "rk_1" })))
      .toEqual({ type: "http", url: "https://mcp.stripe.com", headers: { Authorization: "Bearer rk_1" } });
  });
  it("is null with no key stored, no reader, or a rest transport", () => {
    expect(packApiKeyPin(stripe, reader({}))).toBeNull();
    expect(packApiKeyPin(stripe, undefined)).toBeNull();
    expect(packApiKeyPin({ id: "hub", name: "Hub", apiKey: { transport: "rest", apiBase: "https://api", docsUrl: "https://x" } }, reader({ [apiKeyKeychainKey("hub")]: "k" }))).toBeNull();
  });
  it("is null when a mcp-bearer face has no http mcp to pin", () => {
    expect(packApiKeyPin({ id: "x", name: "X", apiKey: { transport: "mcp-bearer", docsUrl: "https://x" } }, reader({ [apiKeyKeychainKey("x")]: "k" }))).toBeNull();
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

  it("splits across the company-suffixed roots and returns their REAL names", () => {
    const rs = demoRoots();
    pack("notion", { id: "notion", name: "Notion", app: { url: "https://www.notion.so" }, skills: ["notion-search"] },
      { "notion-search": "---\nname: notion-search\n---\n# Search" });
    const d = deps();
    const res = installPack(source, rs, { id: "notion" }, d);
    // The REAL names, not the slots: wiring.ts schedules the commit+push off these, and a slot
    // lookup there found nothing on a provisioned workspace (the install silently missed its push).
    expect(res.target).toBe("private-you");
    expect(res.rulesTarget).toBe("team-acme");
    expect(ex(join(dir, "private-you", "apps", "notion", "app.json"))).toBe(true);
    expect(ex(join(dir, "team-acme", "skills", "notion-search", "SKILL.md"))).toBe(true);
  });

  it("pins an app-less pack installed into the private-* root", () => {
    const rs = demoRoots();
    pack("loc", { id: "loc", name: "Loc", mcp: { kind: "stdio", command: "npx", args: ["-y", "@x/mcp"] } });
    const d = deps();
    const res = installPack(source, rs, { id: "loc" }, d);
    expect(res.target).toBe("private-you");
    expect(d.pins["buildex-pack:loc"]).toEqual({ type: "stdio", command: "npx", args: ["-y", "@x/mcp"] });
  });

  it("reports installedIn as the slot ('private'), not the raw repo name", () => {
    const rs = demoRoots();
    pack("notion", { id: "notion", name: "Notion", app: { url: "https://www.notion.so" } });
    installPack(source, rs, { id: "notion" }, deps());
    const meta = listPacks(source, rs).find((p) => p.id === "notion")!;
    expect(meta.installed).toBe(true);
    expect(meta.installedIn).toBe("private");
  });

  it("uninstalls via the slot round-trip from installedIn", () => {
    const rs = demoRoots();
    pack("notion", { id: "notion", name: "Notion", app: { url: "https://www.notion.so" }, skills: ["notion-search"] },
      { "notion-search": "---\nname: notion-search\n---\n# Search" });
    const d = deps();
    installPack(source, rs, { id: "notion" }, d);
    const slot = listPacks(source, rs).find((p) => p.id === "notion")!.installedIn!;
    uninstallPack(source, rs, { id: "notion", target: slot }, d);
    expect(ex(join(dir, "private-you", "apps", "notion", "app.json"))).toBe(false);
    expect(d.pins["buildex-pack:notion"]).toBeNull();
  });
});

// ---- Pack-shipped classifier corrections (mcp.policy) ---------------------------------------------
// The gateway classifies provider tools by NAME, which only the pack author can correct: a tool that
// reads outward but only reads, or an intent verb whose outward action hides in an argument.
describe("mcp.policy - the pack's classifier baseline", () => {
  const withPolicy = (policy: unknown) => ({
    id: "protocol", name: "Protocol", icon: "🏋️", summary: "Coaching CRM.",
    mcp: { kind: "http", url: "https://api.protocolcrm.com/mcp", policy },
  });

  it("carries a valid policy through to the gateway provider spec as basePolicy", () => {
    const policy = {
      read: ["message"],
      gated: [{ tool: "schedule", when: { action: ["send_reminder"] } }],
    };
    pack("protocol", withPolicy(policy));
    const spec = packMcpProvider(readPack(source, "protocol")!);
    // Named basePolicy, never `policy`: the operator's own overrides own that field, and only theirs
    // are persisted to the keychain.
    expect(spec).toMatchObject({ name: "protocol", basePolicy: policy });
    expect(spec).not.toHaveProperty("policy");
  });

  it("omits basePolicy entirely when the pack declares none", () => {
    pack("protocol", { id: "protocol", name: "Protocol", icon: "🏋️", summary: "x", mcp: { kind: "http", url: "https://api.protocolcrm.com/mcp" } });
    expect(packMcpProvider(readPack(source, "protocol")!)).not.toHaveProperty("basePolicy");
  });

  it("accepts bare names, unconditional rules, and multi-arg conditions", () => {
    for (const policy of [
      { read: ["message"] },
      { gated: [{ tool: "schedule" }] }, // rule with no `when` == the bare-string form
      { gated: [{ tool: "post", when: { target: ["public", "world"], confirm: [true] } }] },
      { gated: [{ tool: "x", when: { n: [1, 2] } }] },
      { hidden: ["internal_debug"] },
      {},
    ]) {
      pack("protocol", withPolicy(policy));
      expect(readPack(source, "protocol"), JSON.stringify(policy)).toBeDefined();
    }
  });

  it("SKIPS the whole pack when the policy is malformed (fails closed)", () => {
    // A pack whose gate we cannot parse must not be offered at all. Dropping just the bad rule would
    // connect the provider with its outward gate silently missing - the one outcome invariant 5 forbids.
    for (const policy of [
      "nope",                                            // not an object
      ["message"],                                       // array, not an object
      { unknownKey: ["x"] },                             // unknown key - refuse rather than ignore
      { read: "message" },                               // list must be an array
      { gated: [{ when: { action: ["run"] } }] },        // rule with no tool
      { gated: [{ tool: "", when: {} }] },               // empty tool name
      { gated: [{ tool: "x", when: { action: [] } }] },  // empty value list matches nothing
      { gated: [{ tool: "x", when: { action: "run" } }] }, // values must be a list
      { gated: [{ tool: "x", when: [] }] },              // `when` must be an object
      { gated: [{ tool: "x", when: { a: [{ b: 1 }] } }] }, // non-scalar value
      { hidden: [{ tool: "x", when: { a: ["b"] } }] },   // hidden takes bare names only
      { read: [""] },                                    // empty name
    ]) {
      pack("protocol", withPolicy(policy));
      expect(readPack(source, "protocol"), JSON.stringify(policy)).toBeUndefined();
      expect(listPacks(source, roots).find((p) => p.id === "protocol"), JSON.stringify(policy)).toBeUndefined();
    }
  });
});
