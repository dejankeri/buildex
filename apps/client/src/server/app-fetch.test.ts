import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKeychain } from "../keychain/keychain.js";
import { brokerAppFetch, setAppSecret, appSecretKeychainKey, urlOriginAllowed, type AppFetchDeps } from "./app-fetch.js";
import type { Root } from "../brain/graph.js";

const SECRET = "sk-app-secret-value";

let dir: string;
let roots: Root[];
let keychain: InMemoryKeychain;
let upstreamCalls: { url: string; method: string; headers: Record<string, string>; body?: string }[];
let approvals: { connector: string; tool: string }[];
let approveNext: boolean;

function seedApp(manifest: object): void {
  const appDir = join(dir, "team", "apps", "crm-demo");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "app.json"), JSON.stringify(manifest));
  writeFileSync(join(appDir, "index.html"), "<h1>hi</h1>");
}

function deps(): AppFetchDeps {
  return {
    roots,
    keychain,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      upstreamCalls.push({
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return new Response(JSON.stringify({ pong: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    approve: async (req) => {
      approvals.push({ connector: req.connector, tool: req.tool });
      return { approved: approveNext };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-appfetch-"));
  roots = [{ name: "team", dir: join(dir, "team") }];
  keychain = new InMemoryKeychain();
  upstreamCalls = [];
  approvals = [];
  approveNext = true;
  seedApp({ name: "CRM", kind: "local", origins: ["https://api.example.com", "https://*.example.org"], secrets: [{ name: "api-key" }, { name: "raw-key", header: "X-Api-Key" }] });
  keychain.set(appSecretKeychainKey("crm-demo", "api-key"), SECRET);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("urlOriginAllowed", () => {
  const origins = ["https://api.example.com", "https://*.example.org"];
  it("matches an exact declared origin, https only", () => {
    expect(urlOriginAllowed(origins, "https://api.example.com/v1/x?y=1")).toBe(true);
    expect(urlOriginAllowed(origins, "http://api.example.com/v1")).toBe(false);
    expect(urlOriginAllowed(origins, "https://api.example.com.evil.io/v1")).toBe(false);
    expect(urlOriginAllowed(origins, "https://api.example.com:8443/v1")).toBe(false); // port changes the origin
  });
  it("matches subdomains under a leading wildcard, separator-safe", () => {
    expect(urlOriginAllowed(origins, "https://eu.example.org/x")).toBe(true);
    expect(urlOriginAllowed(origins, "https://a.b.example.org/x")).toBe(true);
    expect(urlOriginAllowed(origins, "https://example.org/x")).toBe(false); // apex is not a subdomain
    expect(urlOriginAllowed(origins, "https://evilexample.org/x")).toBe(false);
  });
  it("refuses garbage urls and empty allowlists", () => {
    expect(urlOriginAllowed(origins, "not a url")).toBe(false);
    expect(urlOriginAllowed([], "https://api.example.com/x")).toBe(false);
  });
});

describe("brokerAppFetch - declared slot + declared origin, secret attached daemon-side", () => {
  const req = { repo: "team", name: "crm-demo", secret: "api-key", url: "https://api.example.com/v1/ping" };

  it("performs a GET with the default Authorization: Bearer header, no approval card", async () => {
    const r = await brokerAppFetch(deps(), req);
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(r.result).toMatchObject({ status: 200, body: JSON.stringify({ pong: true }), contentType: "application/json" });
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    expect(approvals).toHaveLength(0);
    // the outcome the sandbox will see never carries the secret
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("attaches a bare value under a slot's declared header", async () => {
    keychain.set(appSecretKeychainKey("crm-demo", "raw-key"), "raw-123");
    await brokerAppFetch(deps(), { ...req, secret: "raw-key" });
    expect(upstreamCalls[0]!.headers["x-api-key"]).toBe("raw-123");
    expect(upstreamCalls[0]!.headers["authorization"]).toBeUndefined();
  });

  it("lets only content negotiation cross from the sandbox, and the secret header always wins", async () => {
    await brokerAppFetch(deps(), { ...req, headers: { "content-type": "application/json", "x-sneaky": "1", authorization: "Bearer forged" } });
    const h = upstreamCalls[0]!.headers;
    expect(h["content-type"]).toBe("application/json");
    expect(h["x-sneaky"]).toBeUndefined();
    expect(h["authorization"]).toBe(`Bearer ${SECRET}`);
  });

  it("refuses an undeclared secret slot without touching the network", async () => {
    const r = await brokerAppFetch(deps(), { ...req, secret: "nope" });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(upstreamCalls).toHaveLength(0);
  });

  it("refuses an undeclared origin without touching the network", async () => {
    const r = await brokerAppFetch(deps(), { ...req, url: "https://evil.example.net/exfil" });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(upstreamCalls).toHaveLength(0);
  });

  it("gates a POST on the approver and refuses when the operator declines", async () => {
    approveNext = false;
    const r = await brokerAppFetch(deps(), { ...req, method: "POST", body: '{"x":1}' });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(approvals).toEqual([{ connector: "crm-demo", tool: "POST /v1/ping" }]);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("performs an approved POST with the body forwarded", async () => {
    const r = await brokerAppFetch(deps(), { ...req, method: "POST", body: '{"x":1}' });
    expect(r.ok).toBe(true);
    expect(approvals).toHaveLength(1);
    expect(upstreamCalls[0]).toMatchObject({ method: "POST", body: '{"x":1}' });
  });

  it("404s when no value is stored for a declared slot", async () => {
    keychain.delete(appSecretKeychainKey("crm-demo", "api-key"));
    const r = await brokerAppFetch(deps(), req);
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(upstreamCalls).toHaveLength(0);
  });

  it("404s an unknown app", async () => {
    const r = await brokerAppFetch(deps(), { ...req, name: "nope" });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("502s when the remote is unreachable, without leaking the failure's shape", async () => {
    const d = deps();
    d.fetch = (async () => { throw new Error(`boom ${SECRET}`); }) as typeof fetch;
    const r = await brokerAppFetch(d, req);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe("setAppSecret - console-side store/clear, declared slots only", () => {
  it("stores and clears a declared slot", () => {
    expect(setAppSecret(roots, keychain, { repo: "team", name: "crm-demo", secret: "raw-key", value: "v1" })).toMatchObject({ ok: true, status: 200 });
    expect(keychain.get(appSecretKeychainKey("crm-demo", "raw-key"))).toBe("v1");
    expect(setAppSecret(roots, keychain, { repo: "team", name: "crm-demo", secret: "raw-key", value: null })).toMatchObject({ ok: true, status: 200 });
    expect(keychain.get(appSecretKeychainKey("crm-demo", "raw-key"))).toBeUndefined();
  });

  it("refuses an undeclared slot and an unknown app", () => {
    expect(setAppSecret(roots, keychain, { repo: "team", name: "crm-demo", secret: "nope", value: "v" })).toMatchObject({ ok: false, status: 403 });
    expect(setAppSecret(roots, keychain, { repo: "team", name: "nope", secret: "api-key", value: "v" })).toMatchObject({ ok: false, status: 404 });
    expect(keychain.get(appSecretKeychainKey("crm-demo", "nope"))).toBeUndefined();
  });
});
