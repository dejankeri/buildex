// Hermetic tests for the escape-hatch provisioning flow. No network, no clock, no randomness - the
// CSRF/TTL behaviour (invariant 7) is pinned exactly, because this flow mints a credential BROADER
// than the MCP connection it sits beside.
import { describe, it, expect, vi } from "vitest";
import { ProvisionFlow, dig, provisionRedirectUri, PROVISION_STATE_TTL_MS } from "./provision.js";
import type { PackProvision } from "./catalog.js";

const P: PackProvision = {
  authorizeUrl: "https://app.example.com/connect?redirect_uri={redirect_uri}&state={state}",
  exchangeUrl: "https://api.example.com/v1/exchange",
  codeParam: "code",
  codeField: "code",
  hostField: "host",
  keyPath: "data.apiKey",
  apiBasePath: "data.apiBaseUrl",
  envKey: "EXAMPLE_API_KEY",
  envBase: "EXAMPLE_API_URL",
  grants: "Full account access over the REST API - broader than the MCP connection.",
  docsUrl: "https://help.example.com/connect",
};

const okBody = { success: true, data: { apiKey: "pk_live_abc", apiBaseUrl: "https://api.example.com" } };
const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function flow(over: Partial<Parameters<typeof makeDeps>[0]> = {}) {
  const deps = makeDeps(over);
  return { f: new ProvisionFlow(deps), deps };
}
function makeDeps(over: { fetch?: typeof globalThis.fetch; now?: () => number } = {}) {
  return {
    fetch: over.fetch ?? (vi.fn(async () => jsonRes(okBody)) as unknown as typeof globalThis.fetch),
    now: over.now ?? (() => 1_000),
    randomState: () => "STATE1",
    host: () => "test-mac",
  };
}

describe("dig", () => {
  it("walks a dotted path and returns undefined for any missing hop", () => {
    expect(dig({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
    expect(dig({ a: { b: 1 } }, "a.b.c")).toBeUndefined();
    expect(dig({ a: null }, "a.b")).toBeUndefined();
    expect(dig(undefined, "a")).toBeUndefined();
  });
});

describe("provisionRedirectUri", () => {
  it("is a bare loopback path under its own namespace", () => {
    const uri = provisionRedirectUri("http://127.0.0.1:4317", "protocol");
    expect(uri).toBe("http://127.0.0.1:4317/oauth/provision/protocol/callback");
    // No query string of its own: consent pages append their params with a raw `?`.
    expect(uri).not.toContain("?");
    // Distinct from the MCP gateway callback, so a pack and a provider of the same name never collide.
    expect(uri).not.toMatch(/\/oauth\/protocol\/callback$/);
  });
});

describe("ProvisionFlow.begin", () => {
  it("substitutes both placeholders, URL-encoding the redirect", () => {
    const { f } = flow();
    const { authorizeUrl, grants } = f.begin("protocol", P, "http://127.0.0.1:4317");
    expect(authorizeUrl).toBe(
      "https://app.example.com/connect?redirect_uri=http%3A%2F%2F127.0.0.1%3A4317%2Foauth%2Fprovision%2Fprotocol%2Fcallback&state=STATE1",
    );
    // The operator is told what they're granting at the moment they're asked, not afterwards.
    expect(grants).toBe(P.grants);
  });
});

describe("ProvisionFlow.finish", () => {
  const params = (o: Record<string, string>) => new URLSearchParams(o);

  it("exchanges the code server-to-server and returns the credential", async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => jsonRes(okBody));
    const { f } = flow({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    f.begin("protocol", P, "http://127.0.0.1:4317");
    const res = await f.finish("protocol", P, params({ code: "wsc_1", state: "STATE1" }));
    expect(res).toEqual({ key: "pk_live_abc", apiBase: "https://api.example.com" });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(P.exchangeUrl);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ code: "wsc_1", host: "test-mac" });
  });

  it("omits the host field when the pack does not ask for one", async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => jsonRes(okBody));
    const { f } = flow({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    const { hostField: _drop, ...noHost } = P;
    f.begin("protocol", noHost, "http://127.0.0.1:4317");
    await f.finish("protocol", noHost, params({ code: "wsc_1", state: "STATE1" }));
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ code: "wsc_1" });
  });

  it("refuses a state that does not match, and never exchanges", async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => jsonRes(okBody));
    const { f } = flow({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    f.begin("protocol", P, "http://127.0.0.1:4317");
    await expect(f.finish("protocol", P, params({ code: "wsc_1", state: "WRONG" }))).rejects.toThrow(/state did not match/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a callback with no pending flow at all", async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => jsonRes(okBody));
    const { f } = flow({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    await expect(f.finish("protocol", P, params({ code: "wsc_1", state: "STATE1" }))).rejects.toThrow(/state did not match/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("consumes the state so a replayed callback cannot exchange a second time", async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => jsonRes(okBody));
    const { f } = flow({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    f.begin("protocol", P, "http://127.0.0.1:4317");
    await f.finish("protocol", P, params({ code: "wsc_1", state: "STATE1" }));
    await expect(f.finish("protocol", P, params({ code: "wsc_1", state: "STATE1" }))).rejects.toThrow(/state did not match/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("burns the nonce even when the state was WRONG - no second guess", async () => {
    const { f } = flow();
    f.begin("protocol", P, "http://127.0.0.1:4317");
    await expect(f.finish("protocol", P, params({ code: "c", state: "WRONG" }))).rejects.toThrow();
    // The correct state is now dead too: a failed attempt must not leave the nonce probeable.
    await expect(f.finish("protocol", P, params({ code: "c", state: "STATE1" }))).rejects.toThrow(/state did not match/i);
  });

  it("expires the state after its TTL", async () => {
    let t = 1_000;
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => jsonRes(okBody));
    const { f } = flow({ now: () => t, fetch: fetchMock as unknown as typeof globalThis.fetch });
    f.begin("protocol", P, "http://127.0.0.1:4317");
    t += PROVISION_STATE_TTL_MS + 1;
    await expect(f.finish("protocol", P, params({ code: "wsc_1", state: "STATE1" }))).rejects.toThrow(/expired/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing code without calling the provider", async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => jsonRes(okBody));
    const { f } = flow({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    f.begin("protocol", P, "http://127.0.0.1:4317");
    await expect(f.finish("protocol", P, params({ state: "STATE1" }))).rejects.toThrow(/did not return an authorization code/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains a 401 as an expired single-use code rather than echoing the status", async () => {
    const { f } = flow({ fetch: (async () => jsonRes({ message: "invalid or used connect code" }, 401)) as unknown as typeof globalThis.fetch });
    f.begin("protocol", P, "http://127.0.0.1:4317");
    await expect(f.finish("protocol", P, params({ code: "x", state: "STATE1" }))).rejects.toThrow(/single-use and expires quickly/i);
  });

  it("surfaces other HTTP failures with their status", async () => {
    const { f } = flow({ fetch: (async () => jsonRes({}, 429)) as unknown as typeof globalThis.fetch });
    f.begin("protocol", P, "http://127.0.0.1:4317");
    await expect(f.finish("protocol", P, params({ code: "x", state: "STATE1" }))).rejects.toThrow(/HTTP 429/);
  });

  it("refuses a response whose envelope changed, rather than storing a non-credential", async () => {
    // A provider that renames the field must fail loudly here - storing `undefined` (or an object)
    // as a credential would surface much later as an unexplained 401 against their API.
    for (const body of [{ data: {} }, { data: { apiKey: "" } }, { data: { apiKey: { k: 1 } } }, {}]) {
      const { f } = flow({ fetch: (async () => jsonRes(body)) as unknown as typeof globalThis.fetch });
      f.begin("protocol", P, "http://127.0.0.1:4317");
      await expect(f.finish("protocol", P, params({ code: "x", state: "STATE1" })), JSON.stringify(body)).rejects.toThrow(/did not contain a credential/i);
    }
  });

  it("returns the credential without an apiBase when the provider omits it", async () => {
    const { f } = flow({ fetch: (async () => jsonRes({ data: { apiKey: "pk_live_x" } })) as unknown as typeof globalThis.fetch });
    f.begin("protocol", P, "http://127.0.0.1:4317");
    expect(await f.finish("protocol", P, params({ code: "x", state: "STATE1" }))).toEqual({ key: "pk_live_x" });
  });

  it("rejects a non-JSON response", async () => {
    const bad = { ok: true, status: 200, json: async () => { throw new Error("boom"); } } as unknown as Response;
    const { f } = flow({ fetch: (async () => bad) as unknown as typeof globalThis.fetch });
    f.begin("protocol", P, "http://127.0.0.1:4317");
    await expect(f.finish("protocol", P, params({ code: "x", state: "STATE1" }))).rejects.toThrow(/not valid JSON/i);
  });

  it("keeps flows for different packs independent", async () => {
    const { f } = flow();
    f.begin("protocol", P, "http://127.0.0.1:4317");
    f.begin("other", P, "http://127.0.0.1:4317");
    await expect(f.finish("protocol", P, params({ code: "x", state: "STATE1" }))).resolves.toBeTruthy();
    await expect(f.finish("other", P, params({ code: "x", state: "STATE1" }))).resolves.toBeTruthy();
  });
});
