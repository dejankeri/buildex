// The sandbox face fails CLOSED at face level: a malformed declaration strips the face (the pack
// stays installable, just not e2e-testable) - unlike a malformed policy, which drops the pack,
// because a broken test seam must never cost an operator a working app.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPacks, sandboxKeychainKey, type PackManifest } from "./catalog.js";
import type { CatalogSource } from "./catalog-source.js";

const SANDBOX = {
  createUrl: "https://api.example.com/v1/sandbox/workspaces",
  destroyUrl: "https://api.example.com/v1/sandbox/workspaces/{id}",
  idPath: "data.workspaceId",
  keyPath: "data.apiKey",
  docsUrl: "https://help.example.com/sandbox",
};
const BASE: PackManifest = {
  id: "acme",
  name: "Acme",
  mcp: { kind: "http", url: "https://api.example.com/mcp" },
  apiKey: { transport: "mcp-bearer", docsUrl: "https://help.example.com/keys" },
};

const dirs: string[] = [];

function sourceWith(manifest: PackManifest): CatalogSource {
  const dir = mkdtempSync(join(tmpdir(), "cat-sbx-"));
  dirs.push(dir);
  const packDir = join(dir, manifest.id);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "pack.json"), JSON.stringify(manifest));
  return { ids: () => [manifest.id], dir: (id) => (id === manifest.id ? packDir : undefined) };
}

function facesOf(m: PackManifest) {
  return listPacks(sourceWith(m), [])[0]!.faces;
}

describe("sandbox face parsing", () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a valid face sets faces.sandbox", () => {
    expect(facesOf({ ...BASE, sandbox: SANDBOX }).sandbox).toBe(true);
  });

  it("absent face -> faces.sandbox false", () => {
    expect(facesOf(BASE).sandbox).toBe(false);
  });

  it.each([
    ["http createUrl", { ...SANDBOX, createUrl: "http://api.example.com/x" }],
    ["createUrl with {id}", { ...SANDBOX, createUrl: "https://api.example.com/{id}" }],
    ["destroyUrl missing {id}", { ...SANDBOX, destroyUrl: "https://api.example.com/ws" }],
    ["seedUrl missing {id}", { ...SANDBOX, seedUrl: "https://api.example.com/seed" }],
    ["empty idPath", { ...SANDBOX, idPath: "" }],
    ["missing keyPath", { ...SANDBOX, keyPath: undefined as unknown as string }],
    ["missing docsUrl", { ...SANDBOX, docsUrl: undefined as unknown as string }],
  ])("strips the face but keeps the pack: %s", (_name, bad) => {
    const packs = listPacks(sourceWith({ ...BASE, sandbox: bad as never }), []);
    expect(packs).toHaveLength(1); // pack survives
    expect(packs[0]!.faces.sandbox).toBe(false); // face stripped
    expect(packs[0]!.sandbox).toBeUndefined();
  });

  it("requires the mcp-bearer ride: no apiKey face -> stripped", () => {
    const { apiKey: _drop, ...noKey } = { ...BASE, sandbox: SANDBOX };
    expect(facesOf(noKey as PackManifest).sandbox).toBe(false);
  });

  it("requires an http mcp face: stdio mcp -> stripped", () => {
    const m = { ...BASE, sandbox: SANDBOX, mcp: { kind: "stdio", command: "x" } } as PackManifest;
    expect(facesOf(m).sandbox).toBe(false);
  });
});

describe("sandboxKeychainKey", () => {
  it("is its own namespace, sibling to :apikey and :provisioned", () => {
    expect(sandboxKeychainKey("acme")).toBe("connector:acme:sandbox");
  });
});
