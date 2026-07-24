import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { installPackHeadless, regenAgentConfig, serverAllowRule, verifyInstall } from "./install-step.js";
import type { PackManifest } from "../brain/catalog.js";
import type { CatalogSource } from "../brain/catalog-source.js";
import type { Root } from "../brain/graph.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const M: PackManifest = {
  id: "acme",
  name: "Acme",
  app: { url: "https://app.example.com" },
  mcp: { kind: "http", url: "https://api.example.com/mcp" },
  apiKey: { transport: "mcp-bearer", docsUrl: "https://help.example.com/k" },
  skills: ["acme-howto"],
};

function sourceWith(m: PackManifest): CatalogSource {
  const dir = tmp("cat-");
  const packDir = join(dir, m.id);
  mkdirSync(join(packDir, "skills", "acme-howto"), { recursive: true });
  writeFileSync(join(packDir, "pack.json"), JSON.stringify(m));
  writeFileSync(join(packDir, "skills", "acme-howto", "SKILL.md"), "# acme-howto\n");
  return { ids: () => [m.id], dir: (id) => (id === m.id ? packDir : undefined) };
}

function fakeRoots(): Root[] {
  const ws = tmp("ws-");
  return (["core", "team-acme", "private-you"] as const).map((name) => {
    const dir = join(ws, name);
    mkdirSync(dir, { recursive: true });
    return { name, dir } as Root;
  });
}

describe("installPackHeadless + verifyInstall", () => {
  it("installs app to private, skills+policy to team, and verifyInstall confirms it", () => {
    const source = sourceWith(M);
    const roots = fakeRoots();
    const res = installPackHeadless(source, roots, "acme");
    expect(res.did.app).toBe(true);
    expect(res.did.skills).toEqual(["acme-howto"]);
    const check = verifyInstall(source, roots, "acme");
    expect(check.ok).toBe(true);
    expect(check.app).toBe(true);
    expect(check.skills).toEqual([{ name: "acme-howto", present: true }]);
    expect(check.policyFragment).toBe(true);
    // The face split (catalog.ts installRoots): app face lands under private-you, skills under team-acme.
    expect(existsSync(join(roots[2]!.dir, "apps", "acme", "app.json"))).toBe(true);
    expect(existsSync(join(roots[1]!.dir, "skills", "acme-howto", "SKILL.md"))).toBe(true);
  });

  it("verifyInstall reports a missing skill copy as not ok", () => {
    const source = sourceWith(M);
    const roots = fakeRoots();
    installPackHeadless(source, roots, "acme");
    rmSync(join(roots[1]!.dir, "skills", "acme-howto"), { recursive: true, force: true });
    const check = verifyInstall(source, roots, "acme");
    expect(check.ok).toBe(false);
    expect(check.skills).toEqual([{ name: "acme-howto", present: false }]);
  });

  it("throws on an unknown pack id instead of returning a misleading half-true shape", () => {
    expect(() => verifyInstall(sourceWith(M), fakeRoots(), "ghost")).toThrow(/unknown pack/i);
  });

  it("falls back to the private root for skills+policy when the workspace has no team root", () => {
    const source = sourceWith(M);
    const ws = tmp("ws-");
    const roots = (["core", "private-you"] as const).map((name) => {
      const dir = join(ws, name);
      mkdirSync(dir, { recursive: true });
      return { name, dir } as Root;
    });
    installPackHeadless(source, roots, "acme");
    const check = verifyInstall(source, roots, "acme");
    expect(check.ok).toBe(true);
    expect(existsSync(join(roots[1]!.dir, "skills", "acme-howto", "SKILL.md"))).toBe(true);
  });

  it("reports app=true for a manifest without an app face (nothing to verify)", () => {
    const { app: _a, ...noApp } = M;
    const source = sourceWith(noApp as PackManifest);
    const roots = fakeRoots();
    installPackHeadless(source, roots, "acme");
    const check = verifyInstall(source, roots, "acme");
    expect(check.app).toBe(true);
    expect(check.ok).toBe(true);
  });
});

describe("serverAllowRule", () => {
  it("normalizes the .mcp.json server key the way Claude Code names its tools (verified live: ':' → '_')", () => {
    expect(serverAllowRule("buildex-pack:acme")).toBe("mcp__buildex-pack_acme");
  });
});

describe("regenAgentConfig - the product's post-install config regen, mirrored", () => {
  function corePack(): string {
    const d = tmp("core-");
    mkdirSync(join(d, "policy"), { recursive: true });
    writeFileSync(join(d, "policy", "preset.json"), JSON.stringify({ allow: ["Read"], ask: ["WebFetch"], deny: [] }));
    return d;
  }

  function wsAndRoots(): { workspace: string; roots: Root[] } {
    const workspace = tmp("ws-");
    const roots = (["core", "team-acme", "private-you"] as const).map((name) => {
      const dir = join(workspace, name);
      mkdirSync(dir, { recursive: true });
      return { name, dir } as Root;
    });
    return { workspace, roots };
  }

  it("links the installed pack's skills into .claude/skills and writes the composed settings", () => {
    const { workspace, roots } = wsAndRoots();
    installPackHeadless(sourceWith(M), roots, "acme");
    const { allow } = regenAgentConfig({ workspace, roots, corePackDir: corePack(), allowMcpServer: "buildex-pack:acme", linkStrategy: "copy" });

    expect(existsSync(join(workspace, ".claude", "skills", "acme-howto", "SKILL.md"))).toBe(true);
    expect(existsSync(join(workspace, "CLAUDE.md"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(workspace, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("mcp__buildex-pack_acme");
    expect(settings.permissions.ask).toContain("WebFetch");
    // The returned allow tier is the SAME list written to settings.json (single source of truth) -
    // the harness passes it verbatim to the headless spawn's --allowedTools, so what settings.json
    // grants and what the spawn is allowed can never drift. It carries the core tools this fixture's
    // preset declares (Read) AND the pack's server rule (the real preset.json adds Write/Edit/Bash).
    expect(allow).toEqual(settings.permissions.allow);
    expect(allow).toContain("Read");
    expect(allow).toContain("mcp__buildex-pack_acme");
  });

  it("composes installed pack policy fragments into the preset, like the product's sync", () => {
    const { workspace, roots } = wsAndRoots();
    const m = { ...M, policy: { ask: ["SendEmail"] } } as PackManifest;
    installPackHeadless(sourceWith(m), roots, "acme");
    regenAgentConfig({ workspace, roots, corePackDir: corePack(), linkStrategy: "copy" });

    const settings = JSON.parse(readFileSync(join(workspace, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.ask).toContain("SendEmail");
    // No allowMcpServer given - no mcp__ rule invented.
    expect(settings.permissions.allow.some((r: string) => r.startsWith("mcp__"))).toBe(false);
  });

  it("names the core pack dir operator-readably when preset.json is missing, instead of a bare ENOENT", () => {
    const { workspace, roots } = wsAndRoots();
    const emptyCore = tmp("core-empty-");
    expect(() => regenAgentConfig({ workspace, roots, corePackDir: emptyCore, linkStrategy: "copy" }))
      .toThrow(/preset\.json/);
  });
});
