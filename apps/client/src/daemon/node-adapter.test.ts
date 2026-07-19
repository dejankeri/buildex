import { describe, it, expect } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createNodeServer } from "./node-adapter.js";

describe("createNodeServer - long-turn transport", () => {
  it("disables request and headers timeouts so a multi-minute silent SSE gap is never severed", () => {
    const server = createNodeServer(async () => new Response("ok"));
    // The forced-60s-gap verification item: the server must not time out a long agent turn.
    expect(server.requestTimeout).toBe(0);
    expect(server.headersTimeout).toBe(0);
    server.close();
  });
});

/** Raw HTTP GET/POST to the server on 127.0.0.1 - lets us set Host/Origin that fetch() forbids.
 *  `host`/`origin` override the headers sent; pass null to omit a header entirely. */
function raw(
  port: number,
  headers: { host?: string | null; origin?: string | null; method?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = {};
    if (headers.host !== null) h.host = headers.host ?? `127.0.0.1:${port}`;
    if (headers.origin !== undefined && headers.origin !== null) h.origin = headers.origin;
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/pending", method: headers.method ?? "GET", headers: h },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  // The guard runs before the handler, so the handler body is irrelevant - a request that reaches it
  // returns 200, one rejected by the guard returns 403.
  const server: Server = createNodeServer(async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("createNodeServer - DNS-rebinding / cross-origin guard", () => {
  it("allows a loopback Host with no Origin (the gate hook, OAuth callback, agent bridge)", async () => {
    await withServer(async (port) => {
      expect(await raw(port, { host: `127.0.0.1:${port}`, origin: null })).toBe(200);
      expect(await raw(port, { host: `localhost:${port}`, origin: null })).toBe(200);
    });
  });

  it("allows a loopback Origin (the console's own browser context)", async () => {
    await withServer(async (port) => {
      expect(await raw(port, { origin: `http://127.0.0.1:${port}` })).toBe(200);
      expect(await raw(port, { origin: `http://localhost:${port}` })).toBe(200);
    });
  });

  it("rejects a non-loopback Host with 403 (DNS rebinding)", async () => {
    await withServer(async (port) => {
      expect(await raw(port, { host: "attacker.example", origin: null })).toBe(403);
      expect(await raw(port, { host: `attacker.example:${port}`, origin: null })).toBe(403);
    });
  });

  it("rejects a foreign or opaque Origin with 403 even on a loopback Host (cross-origin fetch)", async () => {
    await withServer(async (port) => {
      expect(await raw(port, { origin: "https://evil.example" })).toBe(403);
      expect(await raw(port, { origin: "null" })).toBe(403);
    });
  });

  it("guards state-changing POSTs the same way", async () => {
    await withServer(async (port) => {
      expect(await raw(port, { method: "POST", origin: "https://evil.example" })).toBe(403);
      expect(await raw(port, { method: "POST", host: "attacker.example", origin: null })).toBe(403);
      expect(await raw(port, { method: "POST", origin: `http://127.0.0.1:${port}` })).toBe(200);
    });
  });
});
