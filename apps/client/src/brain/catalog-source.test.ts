import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleCatalogSource, emptyCatalogSource } from "./catalog-source.js";

let base: string;
let catalogDir: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "buildex-catsrc-"));
  catalogDir = join(base, "catalog");
  mkdirSync(catalogDir, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function seed(id: string, withManifest = true): void {
  const d = join(catalogDir, id);
  mkdirSync(d, { recursive: true });
  if (withManifest) writeFileSync(join(d, "pack.json"), JSON.stringify({ id, name: id }));
}

describe("bundleCatalogSource", () => {
  it("lists pack-dir ids and resolves each to its dir", () => {
    seed("slack");
    seed("notion");
    const src = bundleCatalogSource(catalogDir);
    expect(src.ids().sort()).toEqual(["notion", "slack"]);
    expect(src.dir("slack")).toBe(join(catalogDir, "slack"));
  });

  it("ignores non-dir entries (e.g. a README) and invalid names", () => {
    seed("linear");
    writeFileSync(join(catalogDir, "README.md"), "# Catalog");
    mkdirSync(join(catalogDir, "Bad_Name"), { recursive: true });
    const src = bundleCatalogSource(catalogDir);
    expect(src.ids()).toEqual(["linear"]);
    expect(src.dir("Bad_Name")).toBeUndefined();
    expect(src.dir("../etc")).toBeUndefined();
  });

  it("dir() returns undefined for a dir without a pack.json", () => {
    seed("hollow", false);
    const src = bundleCatalogSource(catalogDir);
    expect(src.ids()).toContain("hollow"); // present as a dir...
    expect(src.dir("hollow")).toBeUndefined(); // ...but not resolvable without a manifest
  });

  it("reads live: a pack added after construction is seen on the next call", () => {
    const src = bundleCatalogSource(catalogDir);
    expect(src.ids()).toEqual([]);
    seed("stripe");
    expect(src.ids()).toEqual(["stripe"]);
  });

  it("is empty (never throws) when the catalog dir does not exist", () => {
    const src = bundleCatalogSource(join(base, "nope"));
    expect(src.ids()).toEqual([]);
    expect(src.dir("slack")).toBeUndefined();
  });
});

describe("emptyCatalogSource", () => {
  it("lists nothing and resolves nothing", () => {
    const src = emptyCatalogSource();
    expect(src.ids()).toEqual([]);
    expect(src.dir("slack")).toBeUndefined();
  });
});
