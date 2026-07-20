import { describe, it, expect, vi } from "vitest";
import { KeychainOAuthProvider, type SecretStore } from "./oauth.js";

function memStore(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k), set: (k, v) => void map.set(k, v), delete: (k) => void map.delete(k) };
}

const opts = (store: SecretStore, openUrl = vi.fn()) => ({
  connector: "gmail",
  store,
  redirectUrl: "http://127.0.0.1:4317/oauth/gmail/callback",
  scopes: ["gmail.readonly", "gmail.send"],
  openUrl,
});

describe("KeychainOAuthProvider - OAuth persistence lives in the keychain seam", () => {
  it("advertises client metadata with our redirect + scopes", () => {
    const p = new KeychainOAuthProvider(opts(memStore()));
    expect(p.redirectUrl).toBe("http://127.0.0.1:4317/oauth/gmail/callback");
    const m = p.clientMetadata;
    expect(m.redirect_uris).toEqual(["http://127.0.0.1:4317/oauth/gmail/callback"]);
    expect(m.scope).toBe("gmail.readonly gmail.send");
    expect(m.grant_types).toContain("refresh_token");
    // ASCII client_name only - some DCR endpoints (Calendly) reject an em-dash as invalid metadata.
    expect(m.client_name).toBe("buildex gmail");
  });

  it("round-trips tokens through the store, namespaced per connector", async () => {
    const store = memStore();
    const p = new KeychainOAuthProvider(opts(store));
    expect(await p.tokens()).toBeUndefined();
    await p.saveTokens({ access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1", expires_in: 3600 });
    expect(await p.tokens()).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
    // stored under a connector-scoped keychain key (never the bare credential key)
    expect([...store.map.keys()][0]).toMatch(/^connector:gmail:oauth:tokens$/);
  });

  it("drops a cached DCR client whose registered redirect no longer matches (re-registers clean)", () => {
    const store = memStore();
    // Registered earlier when our redirect was localhost:4317 ...
    const earlier = new KeychainOAuthProvider({ ...opts(store), redirectUrl: "http://localhost:4317/oauth/gmail/callback" });
    earlier.saveClientInformation({ client_id: "c1" } as never);
    earlier.saveTokens({ access_token: "stale", token_type: "Bearer" } as never);
    // ... now our redirect is 127.0.0.1:4317 (opts default) → genuine drift.
    const now = new KeychainOAuthProvider(opts(store));
    expect(now.clientInformation()).toBeUndefined();        // stale → dropped, forces re-registration
    expect(store.map.has("connector:gmail:oauth:client")).toBe(false);
    expect(store.map.has("connector:gmail:oauth:tokens")).toBe(false); // stale tokens cleared too
  });

  it("keeps a cached client whose registered redirect still matches, and hides the internal marker", () => {
    const store = memStore();
    const p = new KeychainOAuthProvider(opts(store));
    p.saveClientInformation({ client_id: "c1" } as never); // stamped with the current redirect
    expect(p.clientInformation()).toMatchObject({ client_id: "c1" });
    expect(p.clientInformation()).not.toHaveProperty("__buildexRegisteredRedirect");
  });

  it("keeps the client when the server echoes foreign redirect_uris but our registered redirect is unchanged (HeyGen-style DCR)", () => {
    const store = memStore();
    const p = new KeychainOAuthProvider(opts(store)); // redirect 127.0.0.1:4317
    // HeyGen ignores the requested redirect_uris and echoes a fixed allowlist that never contains ours.
    // The drift guard must trust the redirect WE registered with (unchanged), not the server's echo.
    p.saveClientInformation({
      client_id: "hg",
      redirect_uris: ["http://localhost:6274/oauth/callback", "https://chatgpt.com/connector/oauth/x"],
    } as never);
    expect(p.clientInformation()).toMatchObject({ client_id: "hg" });
  });

  it("legacy un-stamped client falls back to the redirect_uris echo comparison", () => {
    const store = memStore();
    const p = new KeychainOAuthProvider(opts(store)); // 127.0.0.1:4317
    const key = "connector:gmail:oauth:client";
    // Persisted before we stamped the redirect: only the server-echoed redirect_uris are available.
    store.set(key, JSON.stringify({ client_id: "old", redirect_uris: ["http://localhost:4317/oauth/gmail/callback"] }));
    expect(p.clientInformation()).toBeUndefined(); // echo doesn't include ours → dropped
    store.set(key, JSON.stringify({ client_id: "old", redirect_uris: ["http://127.0.0.1:4317/oauth/gmail/callback"] }));
    expect(p.clientInformation()).toMatchObject({ client_id: "old" }); // echo matches → kept
  });

  it("round-trips client registration + code verifier", async () => {
    const p = new KeychainOAuthProvider(opts(memStore()));
    await p.saveClientInformation({ client_id: "cid-9", redirect_uris: ["http://127.0.0.1:4317/oauth/gmail/callback"] });
    expect(await p.clientInformation()).toMatchObject({ client_id: "cid-9" });
    p.saveCodeVerifier("verifier-xyz");
    expect(await p.codeVerifier()).toBe("verifier-xyz");
  });

  it("throws if a code verifier is requested before one was saved", async () => {
    const p = new KeychainOAuthProvider(opts(memStore()));
    await expect(Promise.resolve().then(() => p.codeVerifier())).rejects.toThrow(/verifier/i);
  });

  it("opens the authorization URL through the injected opener (no ambient browser)", async () => {
    const open = vi.fn();
    const p = new KeychainOAuthProvider(opts(memStore(), open));
    const url = new URL("https://accounts.example.com/authorize?client_id=cid-9");
    await p.redirectToAuthorization(url);
    expect(open).toHaveBeenCalledWith(url);
  });

  it("invalidates credentials by scope", async () => {
    const store = memStore();
    const p = new KeychainOAuthProvider(opts(store));
    await p.saveTokens({ access_token: "at", token_type: "Bearer" });
    await p.saveClientInformation({ client_id: "cid", redirect_uris: [] });
    p.saveCodeVerifier("v");

    p.invalidateCredentials("tokens");
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toMatchObject({ client_id: "cid" }); // untouched

    p.invalidateCredentials("all");
    expect(await p.clientInformation()).toBeUndefined();
    expect(store.map.size).toBe(0);
  });
});

describe("KeychainOAuthProvider - CSRF state (one-time, short TTL - invariant 7)", () => {
  // The SDK calls state() while building the authorize URL; the daemon callback must then present
  // the same value exactly once, within the TTL. Clock + randomness are injected so this is hermetic.
  const withSeams = (store: SecretStore, now: () => number, randomState?: () => string) => ({
    ...opts(store),
    now,
    ...(randomState ? { randomState } : {}),
  });

  it("state() mints a random url-safe value and persists it under the connector's state slot", () => {
    const store = memStore();
    const p = new KeychainOAuthProvider(withSeams(store, () => 1_000));
    const s = p.state();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(p.state()).not.toEqual(s); // fresh value per authorize
    expect(store.map.has("connector:gmail:oauth:state")).toBe(true);
  });

  it("consumeState accepts the minted state once (valid, within TTL)", () => {
    const p = new KeychainOAuthProvider(withSeams(memStore(), () => 1_000, () => "st-1"));
    expect(p.state()).toBe("st-1");
    expect(() => p.consumeState("st-1")).not.toThrow();
  });

  it("rejects when no authorization is in progress (missing state record)", () => {
    const p = new KeychainOAuthProvider(withSeams(memStore(), () => 1_000));
    expect(() => p.consumeState("anything")).toThrow(/no authorization in progress/i);
  });

  it("rejects a mismatched state - and still consumes the pending one (no retry-guessing)", () => {
    const p = new KeychainOAuthProvider(withSeams(memStore(), () => 1_000, () => "st-1"));
    p.state();
    expect(() => p.consumeState("WRONG")).toThrow(/state mismatch/i);
    // the record was consumed by the failed attempt - even the right value no longer works
    expect(() => p.consumeState("st-1")).toThrow(/no authorization in progress/i);
  });

  it("rejects an expired state (past the 10-minute TTL)", () => {
    let now = 1_000;
    const p = new KeychainOAuthProvider(withSeams(memStore(), () => now, () => "st-1"));
    p.state();
    now += 10 * 60 * 1000 + 1;
    expect(() => p.consumeState("st-1")).toThrow(/expired/i);
  });

  it("cannot be consumed twice (replay)", () => {
    const p = new KeychainOAuthProvider(withSeams(memStore(), () => 1_000, () => "st-1"));
    p.state();
    p.consumeState("st-1");
    expect(() => p.consumeState("st-1")).toThrow(/no authorization in progress/i);
  });

  it("invalidateCredentials('all') clears a pending state", () => {
    const store = memStore();
    const p = new KeychainOAuthProvider(withSeams(store, () => 1_000));
    p.state();
    p.invalidateCredentials("all");
    expect(store.map.size).toBe(0);
    expect(() => p.consumeState("x")).toThrow(/no authorization in progress/i);
  });
});
