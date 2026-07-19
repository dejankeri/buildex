import { describe, it, expect, vi } from "vitest";
import {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  refresh,
  TokenManager,
  type OAuthProviderSpec,
  type StoredTokens,
} from "./rest-oauth.js";

const gmail: OAuthProviderSpec = {
  name: "gmail",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  usesPkce: true,
  extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
};

// A fake fetch that records the last request and returns a canned token response.
function fakeFetch(payload: Record<string, unknown>, opts: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; init: { method?: string; body?: string; headers?: Record<string, string> } }[] = [];
  const fn = vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    calls.push({ url, init });
    return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  });
  return { fn: fn as unknown as Parameters<typeof exchangeCode>[1], calls };
}

function memStore() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v), delete: (k: string) => void m.delete(k), _m: m };
}

describe("PKCE + state", () => {
  it("generatePkce derives an S256 challenge from the verifier (base64url, no padding)", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toEqual(challenge);
    expect(generatePkce().verifier).not.toEqual(verifier); // random
  });
  it("generateState is random and url-safe", () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateState()).not.toEqual(generateState());
  });
});

describe("buildAuthorizeUrl", () => {
  it("carries client_id, redirect, scope, state, PKCE challenge, and provider extras", () => {
    const u = new URL(buildAuthorizeUrl({ spec: gmail, clientId: "cid.apps", redirectUri: "http://127.0.0.1:4317/oauth/connector/gmail/callback", state: "st8", challenge: "chal" }));
    expect(u.searchParams.get("client_id")).toBe("cid.apps");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4317/oauth/connector/gmail/callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(u.searchParams.get("state")).toBe("st8");
    expect(u.searchParams.get("code_challenge")).toBe("chal");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("access_type")).toBe("offline"); // provider extra
  });
});

describe("exchangeCode", () => {
  it("POSTs an authorization_code grant and returns tokens with a computed expiry", async () => {
    const { fn, calls } = fakeFetch({ access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "gmail.readonly" });
    const t = await exchangeCode(
      { spec: gmail, clientId: "cid", code: "code123", verifier: "ver", redirectUri: "http://127.0.0.1:4317/oauth/connector/gmail/callback" },
      fn,
      () => 1_000_000,
    );
    expect(t).toMatchObject({ accessToken: "at1", refreshToken: "rt1", expiresAt: 1_000_000 + 3600 * 1000 });
    expect(calls[0]!.url).toBe(gmail.tokenUrl);
    const body = new URLSearchParams(calls[0]!.init.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code123");
    expect(body.get("code_verifier")).toBe("ver");
  });
  it("throws on a non-ok token response", async () => {
    const { fn } = fakeFetch({ error: "invalid_grant" }, { ok: false, status: 400 });
    await expect(exchangeCode({ spec: gmail, clientId: "cid", code: "x", redirectUri: "r" }, fn)).rejects.toThrow(/400|token/i);
  });
});

describe("per-provider token quirks (one client covers Google/Slack/Notion)", () => {
  const notion: OAuthProviderSpec = {
    name: "notion", authorizeUrl: "https://api.notion.com/v1/oauth/authorize", tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [], usesPkce: false, tokenAuth: "basic", tokenBodyFormat: "json", extraAuthorizeParams: { owner: "user" },
  };
  const slack: OAuthProviderSpec = {
    name: "slack", authorizeUrl: "https://slack.com/oauth/v2/authorize", tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: ["channels:history", "channels:read"], usesPkce: false, scopeParam: "user_scope", scopeSeparator: ",", accessTokenPath: "authed_user.access_token",
  };

  it("Notion: Basic auth header + JSON body, and no scope param when scopes are empty", async () => {
    const { fn, calls } = fakeFetch({ access_token: "notion-tok", workspace_id: "w1" });
    const t = await exchangeCode({ spec: notion, clientId: "nid", clientSecret: "nsec", code: "c", redirectUri: "r" }, fn);
    expect(t.accessToken).toBe("notion-tok");
    expect(calls[0]!.init.headers!["authorization"]).toBe("Basic " + Buffer.from("nid:nsec").toString("base64"));
    expect(calls[0]!.init.headers!["content-type"]).toBe("application/json");
    const parsed = JSON.parse(calls[0]!.init.body!);
    expect(parsed).toMatchObject({ grant_type: "authorization_code", code: "c" });
    expect(parsed.client_id).toBeUndefined(); // creds are in the Basic header, not the body
    // authorize URL omits scope entirely and carries the owner=user extra
    const u = new URL(buildAuthorizeUrl({ spec: notion, clientId: "nid", redirectUri: "r", state: "s" }));
    expect(u.searchParams.has("scope")).toBe(false);
    expect(u.searchParams.get("owner")).toBe("user");
  });

  it("Slack: scopes go in user_scope (comma-joined) and the token is read from authed_user.access_token", async () => {
    const { fn } = fakeFetch({ ok: true, access_token: "xoxb-bot", authed_user: { access_token: "xoxp-user" } });
    const t = await exchangeCode({ spec: slack, clientId: "sid", clientSecret: "ssec", code: "c", redirectUri: "r" }, fn);
    expect(t.accessToken).toBe("xoxp-user"); // the USER token, not the bot token
    const u = new URL(buildAuthorizeUrl({ spec: slack, clientId: "sid", redirectUri: "r", state: "s" }));
    expect(u.searchParams.get("user_scope")).toBe("channels:history,channels:read");
    expect(u.searchParams.has("scope")).toBe(false);
  });
});

describe("refresh", () => {
  it("POSTs a refresh_token grant and preserves the old refresh_token when the provider omits it", async () => {
    const { fn, calls } = fakeFetch({ access_token: "at2", expires_in: 3600 }); // no refresh_token in response
    const t = await refresh({ spec: gmail, clientId: "cid", refreshToken: "rt-old" }, fn, () => 2_000_000);
    expect(t.accessToken).toBe("at2");
    expect(t.refreshToken).toBe("rt-old"); // preserved
    expect(new URLSearchParams(calls[0]!.init.body).get("grant_type")).toBe("refresh_token");
  });
});

describe("TokenManager.getAccessToken", () => {
  const mk = (store: ReturnType<typeof memStore>, fetchFn: Parameters<typeof exchangeCode>[1], now: () => number) =>
    new TokenManager({ connector: "gmail", spec: gmail, clientId: "cid", store, fetch: fetchFn, now });

  it("returns a still-valid token without refreshing", async () => {
    const store = memStore();
    store.set("connector:gmail:oauth:tokens", JSON.stringify({ accessToken: "good", refreshToken: "r", expiresAt: 10_000_000 } as StoredTokens));
    const { fn } = fakeFetch({ access_token: "SHOULD_NOT_BE_USED", expires_in: 3600 });
    const tm = mk(store, fn, () => 5_000_000);
    expect(await tm.getAccessToken()).toBe("good");
    expect(fn).not.toHaveBeenCalled();
  });

  it("refreshes a stale token and persists the new one", async () => {
    const store = memStore();
    store.set("connector:gmail:oauth:tokens", JSON.stringify({ accessToken: "old", refreshToken: "r1", expiresAt: 5_000_000 } as StoredTokens));
    const { fn } = fakeFetch({ access_token: "fresh", expires_in: 3600 });
    const tm = mk(store, fn, () => 5_000_000); // now == expiresAt → within skew → stale
    expect(await tm.getAccessToken()).toBe("fresh");
    expect(JSON.parse(store.get("connector:gmail:oauth:tokens")!).accessToken).toBe("fresh");
  });

  it("forceRefresh refreshes even a valid token (used on a 401 retry)", async () => {
    const store = memStore();
    store.set("connector:gmail:oauth:tokens", JSON.stringify({ accessToken: "valid", refreshToken: "r1", expiresAt: 10_000_000 } as StoredTokens));
    const { fn } = fakeFetch({ access_token: "reissued", expires_in: 3600 });
    const tm = mk(store, fn, () => 5_000_000);
    expect(await tm.getAccessToken({ forceRefresh: true })).toBe("reissued");
  });

  it("throws when there are no stored tokens (not authorized)", async () => {
    const { fn } = fakeFetch({});
    await expect(mk(memStore(), fn, () => 0).getAccessToken()).rejects.toThrow(/authoriz/i);
  });
});
