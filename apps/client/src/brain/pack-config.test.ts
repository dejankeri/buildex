import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedPackMcpEntries, composePreset, reconciledPackMcpEntries } from "./pack-config.js";
import { bundleCatalogSource, type CatalogSource } from "./catalog-source.js";
import type { Root } from "./graph.js";
import type { PolicyPreset } from "../gate/policy.js";

let dir: string, catalogDir: string, source: CatalogSource, roots: Root[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-packcfg-"));
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

// Seed a pack DEFINITION into the (bundled) catalogue - the source of what's available.
function corePack(id: string, m: unknown) {
  const d = join(catalogDir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "pack.json"), JSON.stringify(m));
}
function installApp(root: string, id: string) {
  const d = join(dir, root, "apps", id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "app.json"), JSON.stringify({ kind: "external", url: "https://x.co" }));
}
function frag(root: string, id: string, policy: unknown) {
  const d = join(dir, root, "policy", "packs");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${id}.json`), JSON.stringify(policy));
}

it("direct-pins only stdio/direct packs; gateway-routed (http DCR) packs are excluded", () => {
  corePack("notion", { id: "notion", name: "Notion", app: { url: "https://x.co" }, mcp: { kind: "http", url: "https://mcp.notion.com/mcp" } }); // DCR → gateway
  corePack("gmail", { id: "gmail", name: "Gmail", app: { url: "https://x.co" }, mcp: { kind: "http", url: "https://gmailmcp.googleapis.com/mcp/v1", direct: true } }); // non-DCR → direct pin
  corePack("noapp", { id: "noapp", name: "NoApp", mcp: { kind: "http", url: "https://y.co" } }); // not installed
  installApp("team", "notion");
  installApp("team", "gmail");
  const entries = installedPackMcpEntries(source, roots);
  expect(entries["buildex-pack:notion"]).toBeUndefined();  // routed through the gateway, not direct-pinned
  expect(entries["buildex-pack:gmail"]).toEqual({ type: "http", url: "https://gmailmcp.googleapis.com/mcp/v1" }); // direct
  expect(entries["buildex-pack:noapp"]).toBeUndefined();   // not installed
});

it("direct-pins an app-less local (stdio) pack once its install marker exists", () => {
  corePack("toolonly", { id: "toolonly", name: "ToolOnly", mcp: { kind: "stdio", command: "npx", args: ["-y", "@x/mcp"] } });
  frag("private", "toolonly", {}); // the always-written install marker (no app.json for this pack)
  const entries = installedPackMcpEntries(source, roots);
  expect(entries["buildex-pack:toolonly"]).toEqual({ type: "stdio", command: "npx", args: ["-y", "@x/mcp"] });
});

it("composePreset unions base rules with installed-pack policy fragments", () => {
  const base: PolicyPreset = { allow: ["Read"], ask: ["Bash"], deny: [], default: "ask" };
  frag("team", "notion", { allow: ["mcp__notion__search"], ask: ["mcp__notion__create_page"] });
  const eff = composePreset(base, roots);
  expect(eff.allow).toContain("Read");
  expect(eff.allow).toContain("mcp__notion__search");
  expect(eff.ask).toEqual(expect.arrayContaining(["Bash", "mcp__notion__create_page"]));
  expect(eff.default).toBe("ask");
});

it("composePreset returns the base unchanged when no fragments exist", () => {
  const base: PolicyPreset = { allow: ["Read"], ask: [], deny: ["Bash(rm:*)"], default: "deny" };
  const eff = composePreset(base, roots);
  expect(eff.allow).toEqual(["Read"]);
  expect(eff.deny).toEqual(["Bash(rm:*)"]);
});

it("reconciledPackMcpEntries nulls stale + gateway-migrated pack keys, keeps stdio pins and non-pack keys", () => {
  corePack("notion", { id: "notion", name: "Notion", app: { url: "https://x.co" }, mcp: { kind: "http", url: "https://mcp.notion.com/mcp" } }); // now gateway-routed
  corePack("localtool", { id: "localtool", name: "Local", mcp: { kind: "stdio", command: "npx" } });
  installApp("team", "notion");
  frag("team", "localtool", {});
  const ws = join(dir, "team"); // stand-in workspace holding .mcp.json
  writeFileSync(join(ws, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "buildex-connectors": { type: "http", url: "http://127.0.0.1/gw" }, // must survive
      "buildex-pack:notion": { type: "http", url: "https://old" },        // gateway-routed now → null (migrate off direct pin)
      "buildex-pack:removed": { type: "http", url: "https://gone" },      // no longer installed → null
    },
  }));
  const entries = reconciledPackMcpEntries(source, ws, roots);
  expect(entries["buildex-pack:notion"]).toBeNull();                                 // migrated to the gateway
  expect(entries["buildex-pack:removed"]).toBeNull();                                // uninstalled
  expect(entries["buildex-pack:localtool"]).toEqual({ type: "stdio", command: "npx" }); // stdio stays direct-pinned
  expect("buildex-connectors" in entries).toBe(false);                               // untouched - not a pack key
});
