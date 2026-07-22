import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintAndPin, withSandbox } from "./sandbox-step.js";
import type { PackManifest } from "../brain/catalog.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ws = () => { const d = mkdtempSync(join(tmpdir(), "sbx-step-")); dirs.push(d); return d; };

const M: PackManifest = {
  id: "acme", name: "Acme",
  mcp: { kind: "http", url: "https://api.example.com/mcp" },
  apiKey: { transport: "mcp-bearer", docsUrl: "https://help.example.com/k" },
  sandbox: {
    createUrl: "https://api.example.com/v1/sandbox/workspaces",
    destroyUrl: "https://api.example.com/v1/sandbox/workspaces/{id}",
    idPath: "data.workspaceId", keyPath: "data.apiKey", mcpUrlPath: "data.mcpUrl",
    docsUrl: "https://help.example.com/sandbox",
  },
};
const okBody = { data: { workspaceId: "ws_1", apiKey: "sb_pk_1", mcpUrl: "https://ws1.example.com/mcp" } };
const res = (status: number, body?: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe("mintAndPin", () => {
  it("mints and writes the buildex-pack pin with the MINTED key and mcpUrl override", async () => {
    const w = ws();
    const fetchMock = vi.fn(async () => res(201, okBody));
    const got = await mintAndPin(M, "sb_admin", { workspace: w, runName: "r1", host: "OPERATOR-PC" }, { fetch: fetchMock as unknown as typeof globalThis.fetch });
    expect(got.id).toBe("ws_1");
    const cfg = JSON.parse(readFileSync(join(w, ".mcp.json"), "utf8"));
    expect(cfg.mcpServers["buildex-pack:acme"]).toEqual({
      type: "http", url: "https://ws1.example.com/mcp", headers: { Authorization: "Bearer sb_pk_1" },
    });
  });

  it("merges into an existing .mcp.json without clobbering other servers", async () => {
    const w = ws();
    writeFileSync(join(w, ".mcp.json"), JSON.stringify({ mcpServers: { other: { type: "http", url: "https://x.example.com" } } }));
    await mintAndPin(M, "k", { workspace: w, runName: "r", host: "h" }, { fetch: (vi.fn(async () => res(201, okBody))) as unknown as typeof globalThis.fetch });
    const cfg = JSON.parse(readFileSync(join(w, ".mcp.json"), "utf8"));
    expect(cfg.mcpServers.other).toEqual({ type: "http", url: "https://x.example.com" });
    expect(cfg.mcpServers["buildex-pack:acme"]).toBeDefined();
  });

  it("throws before any fetch when the pack has no sandbox face", async () => {
    const fetchMock = vi.fn();
    const { sandbox: _s, ...bare } = M;
    await expect(mintAndPin(bare as PackManifest, "k", { workspace: ws(), runName: "r", host: "h" }, { fetch: fetchMock as unknown as typeof globalThis.fetch }))
      .rejects.toThrow(/no sandbox face/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("withSandbox", () => {
  it("destroys on success", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (u: string | URL | Request, i?: RequestInit) => { calls.push(`${i?.method} ${u}`); return i?.method === "DELETE" ? res(204) : res(201, okBody); });
    const out = await withSandbox(M, "k", { workspace: ws(), runName: "r", host: "h" }, { fetch: fetchMock as unknown as typeof globalThis.fetch }, async () => "ok");
    expect(out).toBe("ok");
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(true);
  });

  it("destroys on failure and rethrows the ORIGINAL error", async () => {
    const fetchMock = vi.fn(async (u: string | URL | Request, i?: RequestInit) => (i?.method === "DELETE" ? res(204) : res(201, okBody)));
    await expect(
      withSandbox(M, "k", { workspace: ws(), runName: "r", host: "h" }, { fetch: fetchMock as unknown as typeof globalThis.fetch }, async () => { throw new Error("scenario exploded"); }),
    ).rejects.toThrow("scenario exploded");
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "DELETE")).toBe(true);
  });

  it("rejects with the destroy error when fn succeeds but destroy fails", async () => {
    const fetchMock = vi.fn(async (u: string | URL | Request, i?: RequestInit) => (i?.method === "DELETE" ? res(500) : res(201, okBody)));
    await expect(
      withSandbox(M, "k", { workspace: ws(), runName: "r", host: "h" }, { fetch: fetchMock as unknown as typeof globalThis.fetch }, async () => "ok"),
    ).rejects.toThrow(/destroy sandbox workspace/i);
  });
});
