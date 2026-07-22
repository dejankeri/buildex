// Hermetic tests for the sandbox lifecycle client. No network - fetch is injected. Destroy is the
// engine's only unconditional step, so its idempotency (404 = already gone = success) is pinned.
import { describe, it, expect, vi } from "vitest";
import { createSandboxWorkspace, destroySandboxWorkspace, seedSandboxWorkspace, SANDBOX_AUTH_HEADER } from "./sandbox.js";
import type { PackSandbox } from "./catalog.js";

const S: PackSandbox = {
  createUrl: "https://api.example.com/v1/sandbox/workspaces",
  destroyUrl: "https://api.example.com/v1/sandbox/workspaces/{id}",
  idPath: "data.workspaceId",
  keyPath: "data.apiKey",
  mcpUrlPath: "data.mcpUrl",
  docsUrl: "https://help.example.com/sandbox",
};
const okBody = { data: { workspaceId: "ws_1", apiKey: "sb_pk_1", mcpUrl: "https://ws1.example.com/mcp" } };
const res = (status: number, body?: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const fetchOf = (r: Response) => vi.fn(async () => r) as unknown as typeof globalThis.fetch;

describe("createSandboxWorkspace", () => {
  it("POSTs name+host with the secret in the default auth header and extracts id/key/mcpUrl", async () => {
    const fetchMock = vi.fn(async () => res(201, okBody));
    const ws = await createSandboxWorkspace(S, "sb_admin", { name: "e2e-acme", host: "OPERATOR-PC" }, { fetch: fetchMock as unknown as typeof globalThis.fetch });
    expect(ws).toEqual({ id: "ws_1", key: "sb_pk_1", mcpUrl: "https://ws1.example.com/mcp" });
    const [url, init] = (fetchMock.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe(S.createUrl);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)[SANDBOX_AUTH_HEADER]).toBe("sb_admin");
    expect(JSON.parse(init.body as string)).toEqual({ name: "e2e-acme", host: "OPERATOR-PC" });
  });

  it("honors a custom authHeader", async () => {
    const fetchMock = vi.fn(async () => res(201, okBody));
    await createSandboxWorkspace({ ...S, authHeader: "x-acme-sb" }, "k", { name: "n", host: "h" }, { fetch: fetchMock as unknown as typeof globalThis.fetch });
    const [, init] = (fetchMock.mock.calls[0] as unknown) as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-acme-sb"]).toBe("k");
  });

  it("omits mcpUrl when the face has no mcpUrlPath", async () => {
    const { mcpUrlPath: _m, ...noMcp } = S;
    const ws = await createSandboxWorkspace(noMcp as PackSandbox, "k", { name: "n", host: "h" }, { fetch: fetchOf(res(201, okBody)) });
    expect(ws).toEqual({ id: "ws_1", key: "sb_pk_1" });
  });

  it("throws operator-readably when the faucet refuses", async () => {
    await expect(createSandboxWorkspace(S, "k", { name: "n", host: "h" }, { fetch: fetchOf(res(403)) }))
      .rejects.toThrow(/refused .*403/i);
  });

  it("throws when the response lacks the id or key", async () => {
    await expect(createSandboxWorkspace(S, "k", { name: "n", host: "h" }, { fetch: fetchOf(res(201, { data: {} })) }))
      .rejects.toThrow(/did not contain/i);
  });

  it("throws on a non-JSON response body", async () => {
    const bad = { ok: true, status: 201, json: async () => { throw new Error("nope"); } } as unknown as Response;
    await expect(createSandboxWorkspace(S, "k", { name: "n", host: "h" }, { fetch: fetchOf(bad) }))
      .rejects.toThrow(/not valid JSON/i);
  });
});

describe("destroySandboxWorkspace", () => {
  it("DELETEs the substituted url with the secret", async () => {
    const fetchMock = vi.fn(async () => res(204));
    await destroySandboxWorkspace(S, "sb_admin", "ws_1", { fetch: fetchMock as unknown as typeof globalThis.fetch });
    const [url, init] = (fetchMock.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/sandbox/workspaces/ws_1");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>)[SANDBOX_AUTH_HEADER]).toBe("sb_admin");
  });

  it("treats 404 as success (already gone) - destroy is idempotent", async () => {
    await expect(destroySandboxWorkspace(S, "k", "ws_1", { fetch: fetchOf(res(404)) })).resolves.toBeUndefined();
  });

  it("throws on any other failure so a leaked workspace is never silent", async () => {
    await expect(destroySandboxWorkspace(S, "k", "ws_1", { fetch: fetchOf(res(500)) })).rejects.toThrow(/500/);
  });

  it("URL-encodes the id", async () => {
    const fetchMock = vi.fn(async () => res(204));
    await destroySandboxWorkspace(S, "k", "ws/../1", { fetch: fetchMock as unknown as typeof globalThis.fetch });
    const [url] = (fetchMock.mock.calls[0] as unknown) as [string];
    expect(url).toBe("https://api.example.com/v1/sandbox/workspaces/ws%2F..%2F1");
  });
});

describe("seedSandboxWorkspace", () => {
  const withSeed: PackSandbox = { ...S, seedUrl: "https://api.example.com/v1/sandbox/workspaces/{id}/seed" };

  it("POSTs the seed document to the substituted url", async () => {
    const fetchMock = vi.fn(async () => res(200));
    await seedSandboxWorkspace(withSeed, "sb_admin", "ws_1", { clients: [{ name: "A" }] }, { fetch: fetchMock as unknown as typeof globalThis.fetch });
    const [url, init] = (fetchMock.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/sandbox/workspaces/ws_1/seed");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)[SANDBOX_AUTH_HEADER]).toBe("sb_admin");
    expect(JSON.parse(init.body as string)).toEqual({ clients: [{ name: "A" }] });
  });

  it("throws when the face declares no seedUrl - callers must check, not guess", async () => {
    await expect(seedSandboxWorkspace(S, "k", "ws_1", {}, { fetch: fetchOf(res(200)) }))
      .rejects.toThrow(/no seed endpoint/i);
  });

  it("throws operator-readably on refusal", async () => {
    await expect(seedSandboxWorkspace(withSeed, "k", "ws_1", {}, { fetch: fetchOf(res(422)) }))
      .rejects.toThrow(/422/);
  });
});
