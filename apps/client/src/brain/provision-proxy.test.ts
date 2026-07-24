import { describe, it, expect, afterEach, vi } from "vitest";
import { request } from "node:http";
import { startProvisionProxy, type ProvisionProxyHost } from "./provision-proxy.js";

const TOKEN = "test-provision-token";

/** A fake upstream: records every forwarded call and answers with a recognizable body. */
function fakeUpstream(status = 200) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body != null ? { body: String(init.body) } : {}),
    });
    return new Response(JSON.stringify({ from: "provider" }), { status, headers: { "content-type": "application/json" } });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/** Raw HTTP to the proxy - lets tests set Host/Origin headers fetch() forbids. */
function raw(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

let host: ProvisionProxyHost | undefined;
afterEach(async () => {
  if (host) await host.close();
  host = undefined;
});

const target = { baseUrl: "https://api.example.com", headers: { Authorization: "Bearer provider-key" } };

async function startHost(opts: {
  fetchImpl: typeof fetch;
  approve?: (req: { connector: string; tool: string; args: unknown; summary: string }) => Promise<{ approved: boolean; reason?: string }>;
  resolve?: (id: string) => typeof target | undefined;
}): Promise<ProvisionProxyHost> {
  host = await startProvisionProxy({
    token: TOKEN,
    fetch: opts.fetchImpl,
    resolve: opts.resolve ?? ((id) => (id === "example" ? target : undefined)),
    approve: opts.approve ?? (async () => ({ approved: true })),
  });
  return host;
}

describe("startProvisionProxy - the daemon-held credential proxy the agent calls instead of the provider", () => {
  it("forwards a GET with the provider auth header attached, path + query preserved, status/body streamed back", async () => {
    const up = fakeUpstream();
    const approve = vi.fn(async () => ({ approved: true }));
    const h = await startHost({ fetchImpl: up.fetchImpl, approve });

    const res = await fetch(`${h.url}/example/v1/clients?limit=2`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: "provider" });
    expect(res.headers.get("content-type")).toContain("application/json");

    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]).toMatchObject({ url: "https://api.example.com/v1/clients?limit=2", method: "GET" });
    // the provider credential is attached daemon-side...
    expect(up.calls[0]!.headers["authorization"]).toBe("Bearer provider-key");
    // ...and a read never consults the operator (GET/HEAD pass silently)
    expect(approve).not.toHaveBeenCalled();
  });

  it("never forwards the proxy's own bearer upstream - the provider sees only its credential", async () => {
    const up = fakeUpstream();
    const h = await startHost({ fetchImpl: up.fetchImpl });
    await fetch(`${h.url}/example/v1/me`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(up.calls[0]!.headers["authorization"]).toBe("Bearer provider-key");
    expect(JSON.stringify(up.calls[0]!.headers)).not.toContain(TOKEN);
  });

  it("HEAD passes silently too", async () => {
    const up = fakeUpstream();
    const approve = vi.fn(async () => ({ approved: true }));
    const h = await startHost({ fetchImpl: up.fetchImpl, approve });
    const res = await fetch(`${h.url}/example/v1/clients`, { method: "HEAD", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(approve).not.toHaveBeenCalled();
  });

  it("gates every non-GET/HEAD method on the approver: approve → forwarded with method + body", async () => {
    const up = fakeUpstream();
    const approve = vi.fn(async () => ({ approved: true }));
    const h = await startHost({ fetchImpl: up.fetchImpl, approve });

    const res = await fetch(`${h.url}/example/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "client-1", text: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ connector: "example", tool: "POST /v1/messages" }),
    );
    expect(up.calls[0]).toMatchObject({ method: "POST", body: JSON.stringify({ to: "client-1", text: "hi" }) });
    expect(up.calls[0]!.headers["content-type"]).toBe("application/json");
  });

  it("deny → 403 and the provider is never called", async () => {
    const up = fakeUpstream();
    const h = await startHost({ fetchImpl: up.fetchImpl, approve: async () => ({ approved: false }) });
    const res = await fetch(`${h.url}/example/v1/clients/9`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(403);
    expect(up.calls).toHaveLength(0);
  });

  it("streams the upstream status through unchanged (a provider 404 is the agent's 404)", async () => {
    const up = fakeUpstream(404);
    const h = await startHost({ fetchImpl: up.fetchImpl });
    const res = await fetch(`${h.url}/example/v1/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("an unreachable provider is a 502, never a hang or a crash", async () => {
    const h = await startHost({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    const res = await fetch(`${h.url}/example/v1/x`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(502);
  });

  it("404s a pack the resolver does not vouch for (unknown, uninstalled, or unprovisioned)", async () => {
    const up = fakeUpstream();
    const h = await startHost({ fetchImpl: up.fetchImpl, resolve: () => undefined });
    const res = await fetch(`${h.url}/example/v1/x`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
    expect(up.calls).toHaveLength(0);
  });

  it("404s anything outside /provision and a malformed pack id", async () => {
    const up = fakeUpstream();
    const h = await startHost({ fetchImpl: up.fetchImpl });
    const base = `http://127.0.0.1:${h.port}`;
    expect((await fetch(`${base}/other`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await fetch(`${h.url}/Not-A-Pack/x`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  });

  it("401s a missing or wrong bearer (constant-time compare, like the gateway)", async () => {
    const up = fakeUpstream();
    const h = await startHost({ fetchImpl: up.fetchImpl });
    expect((await fetch(`${h.url}/example/v1/x`)).status).toBe(401);
    expect((await fetch(`${h.url}/example/v1/x`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("403s a non-loopback Host (DNS rebinding) and a foreign Origin, before auth is even checked", async () => {
    const up = fakeUpstream();
    const h = await startHost({ fetchImpl: up.fetchImpl });
    expect(await raw(h.port, "/provision/example/v1/x", { host: "evil.example", authorization: `Bearer ${TOKEN}` })).toBe(403);
    expect(await raw(h.port, "/provision/example/v1/x", { origin: "https://evil.example", authorization: `Bearer ${TOKEN}` })).toBe(403);
    // absent Origin (the agent's curl) with a loopback Host is fine - that path is covered above
    expect(up.calls).toHaveLength(0);
  });
});
