// Hermetic tests for makeJwksCache: a fake `fetch` counting calls and a controllable clock stand
// in for the network and wall-clock time, so no real HTTP request or timer is ever involved.
import { describe, it, expect } from "vitest";
import type { JsonWebKey } from "node:crypto";
import { makeJwksCache } from "./jwks-cache.js";
import { JwtError } from "./jwt-verify.js";

const KEY_1: JsonWebKey = { kty: "RSA", kid: "k1", n: "n1", e: "AQAB" } as JsonWebKey;
const KEY_2: JsonWebKey = { kty: "RSA", kid: "k2", n: "n2", e: "AQAB" } as JsonWebKey;

/** A fake `fetch` that counts calls and serves a JWKS response from a mutable `keys` array. */
function makeFakeFetch(keysProvider: () => JsonWebKey[]) {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return {
      json: async () => ({ keys: keysProvider() }),
    } as Response;
  }) as typeof fetch;
  return { fetchFn, callCount: () => calls };
}

describe("makeJwksCache", () => {
  it("fetches on the first resolve", async () => {
    const { fetchFn, callCount } = makeFakeFetch(() => [KEY_1]);
    const cache = makeJwksCache({ url: "https://example.test/jwks", fetch: fetchFn, now: () => 0 });

    const jwk = await cache.resolve("k1");

    expect(jwk).toEqual(KEY_1);
    expect(callCount()).toBe(1);
  });

  it("does not refetch a known kid within TTL", async () => {
    const { fetchFn, callCount } = makeFakeFetch(() => [KEY_1]);
    const cache = makeJwksCache({ url: "https://example.test/jwks", fetch: fetchFn, now: () => 0 });

    await cache.resolve("k1");
    const jwk = await cache.resolve("k1");

    expect(jwk).toEqual(KEY_1);
    expect(callCount()).toBe(1);
  });

  it("refetches exactly once on an unknown kid and returns it if rotation added it", async () => {
    let keys = [KEY_1];
    const { fetchFn, callCount } = makeFakeFetch(() => keys);
    const cache = makeJwksCache({ url: "https://example.test/jwks", fetch: fetchFn, now: () => 0 });

    await cache.resolve("k1");
    expect(callCount()).toBe(1);

    // Simulate key rotation: the JWKS endpoint now serves k2 as well.
    keys = [KEY_1, KEY_2];
    const jwk = await cache.resolve("k2");

    expect(jwk).toEqual(KEY_2);
    expect(callCount()).toBe(2);
  });

  it("throws JwtError for a kid still unknown after the refetch", async () => {
    const { fetchFn, callCount } = makeFakeFetch(() => [KEY_1]);
    const cache = makeJwksCache({ url: "https://example.test/jwks", fetch: fetchFn, now: () => 0 });

    await expect(cache.resolve("nope")).rejects.toThrow(JwtError);
    // One fetch on the first ever resolve, one refetch attempt for the unknown kid.
    expect(callCount()).toBe(1);
  });

  it("refetches after ttlMs elapses", async () => {
    let clock = 0;
    const { fetchFn, callCount } = makeFakeFetch(() => [KEY_1]);
    const cache = makeJwksCache({
      url: "https://example.test/jwks",
      fetch: fetchFn,
      now: () => clock,
      ttlMs: 1000,
    });

    await cache.resolve("k1");
    expect(callCount()).toBe(1);

    clock += 500;
    await cache.resolve("k1");
    expect(callCount()).toBe(1); // still within TTL

    clock += 600; // now 1100ms since fetch, past the 1000ms TTL
    await cache.resolve("k1");
    expect(callCount()).toBe(2);
  });

  it("shares one in-flight fetch across concurrent resolves on a miss", async () => {
    const { fetchFn, callCount } = makeFakeFetch(() => [KEY_1]);
    const cache = makeJwksCache({ url: "https://example.test/jwks", fetch: fetchFn, now: () => 0 });

    const [a, b, c] = await Promise.all([
      cache.resolve("k1"),
      cache.resolve("k1"),
      cache.resolve("k1"),
    ]);

    expect(a).toEqual(KEY_1);
    expect(b).toEqual(KEY_1);
    expect(c).toEqual(KEY_1);
    expect(callCount()).toBe(1);
  });
});
