import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPackHeadless, verifyInstall } from "./install-step.js";
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
});
