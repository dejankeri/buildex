// Hermetic tests for the mcp discovery client. No network - fetch is injected. Covers both wire
// encodings a live server may answer with (SSE, plain JSON), the session-id handshake, and every
// operator-readable failure path.
import { describe, it, expect, vi } from "vitest";
import { listMcpTools } from "./mcp-tools.js";

const okTools = [
  { name: "b_tool", description: "does b" },
  { name: "a_tool", description: "does a" },
];

/** Wraps a JSON-RPC result payload as an SSE body, the way a live streamable-http MCP server sends it. */
const sse = (result: unknown) => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;
const plain = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

const res = (status: number, text: string, headers: Record<string, string> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    headers: { get: (k: string) => headers[k] ?? null },
  }) as unknown as Response;

describe("listMcpTools", () => {
  it("discovers tools from an SSE-encoded response, sorted by name", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, sse({})))
      .mockResolvedValueOnce(res(200, sse({ tools: okTools })));
    const tools = await listMcpTools({ url: "https://mcp.example.com", headers: {} }, { fetch: fetchMock as unknown as typeof globalThis.fetch });
    expect(tools).toEqual([
      { name: "a_tool", description: "does a" },
      { name: "b_tool", description: "does b" },
    ]);
  });

  it("discovers tools from a plain-JSON response, sorted by name", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, plain({})))
      .mockResolvedValueOnce(res(200, plain({ tools: okTools })));
    const tools = await listMcpTools({ url: "https://mcp.example.com", headers: {} }, { fetch: fetchMock as unknown as typeof globalThis.fetch });
    expect(tools).toEqual([
      { name: "a_tool", description: "does a" },
      { name: "b_tool", description: "does b" },
    ]);
  });

  it("echoes the mcp-session-id captured on initialize as a request header on tools/list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, plain({}), { "mcp-session-id": "sess_123" }))
      .mockResolvedValueOnce(res(200, plain({ tools: [] })));
    await listMcpTools({ url: "https://mcp.example.com", headers: { "x-caller": "yes" } }, { fetch: fetchMock as unknown as typeof globalThis.fetch });

    const [, initInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, listInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((initInit.headers as Record<string, string>)["mcp-session-id"]).toBeUndefined();
    expect((listInit.headers as Record<string, string>)["mcp-session-id"]).toBe("sess_123");
    // caller-supplied headers plus the protocol-required ones ride every call
    expect((listInit.headers as Record<string, string>)["x-caller"]).toBe("yes");
    expect((listInit.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((listInit.headers as Record<string, string>)["accept"]).toBe("application/json, text/event-stream");
  });

  it("stays stateless when the server returns no session-id header", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, plain({}))).mockResolvedValueOnce(res(200, plain({ tools: [] })));
    await listMcpTools({ url: "https://mcp.example.com", headers: {} }, { fetch: fetchMock as unknown as typeof globalThis.fetch });
    const [, listInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((listInit.headers as Record<string, string>)["mcp-session-id"]).toBeUndefined();
  });

  it("throws operator-readably naming the failing call when the server refuses initialize", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(401, ""));
    await expect(listMcpTools({ url: "https://mcp.example.com", headers: {} }, { fetch: fetchMock as unknown as typeof globalThis.fetch })).rejects.toThrow(
      /refused the mcp initialize \(HTTP 401\)/,
    );
  });

  it("throws when a response body is not valid JSON (and isn't SSE-shaped either)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, "not json at all"));
    await expect(listMcpTools({ url: "https://mcp.example.com", headers: {} }, { fetch: fetchMock as unknown as typeof globalThis.fetch })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("throws when the tools/list result has no tools array at all", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, plain({}))).mockResolvedValueOnce(res(200, plain({ notTools: [] })));
    await expect(listMcpTools({ url: "https://mcp.example.com", headers: {} }, { fetch: fetchMock as unknown as typeof globalThis.fetch })).rejects.toThrow(
      /did not contain tools/,
    );
  });

  it("returns an empty surface when tools/list answers with a genuinely empty tools array", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, plain({}))).mockResolvedValueOnce(res(200, plain({ tools: [] })));
    await expect(
      listMcpTools({ url: "https://mcp.example.com", headers: {} }, { fetch: fetchMock as unknown as typeof globalThis.fetch }),
    ).resolves.toEqual([]);
  });

  it("drops entries missing a name and fails soft on a missing description, without erroring the whole surface", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, plain({})))
      .mockResolvedValueOnce(res(200, plain({ tools: [{ description: "orphaned" }, { name: "only_name" }] })));
    const tools = await listMcpTools({ url: "https://mcp.example.com", headers: {} }, { fetch: fetchMock as unknown as typeof globalThis.fetch });
    expect(tools).toEqual([{ name: "only_name", description: "" }]);
  });

  it("wraps a rejected fetch into an operator-readable error naming the failing call", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(listMcpTools({ url: "https://mcp.example.com", headers: {} }, { fetch: fetchMock as unknown as typeof globalThis.fetch })).rejects.toThrow(
      /could not reach/,
    );
  });

  it("POSTs the initialize handshake with protocolVersion and clientInfo", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, plain({}))).mockResolvedValueOnce(res(200, plain({ tools: [] })));
    await listMcpTools({ url: "https://mcp.example.com", headers: {} }, { fetch: fetchMock as unknown as typeof globalThis.fetch });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mcp.example.com");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.method).toBe("initialize");
    expect(body.params).toEqual({
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "buildex-e2e", version: "0.0.1" },
    });
  });
});
