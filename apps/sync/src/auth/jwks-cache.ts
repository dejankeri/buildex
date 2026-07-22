// Caches a Supabase JWKS endpoint's keys by `kid`, serving from cache within a TTL and refetching
// exactly once on a cache miss (the shape of a key rotation: an unrecognized kid shows up, and one
// refetch is enough to pick up the new key if the rotation has already published it). Concurrent
// misses share a single in-flight fetch so N simultaneous unknown-kid resolves cost one request.
import type { JsonWebKey } from "node:crypto";
import { JwtError } from "./jwt-verify.js";
import type { JwkResolver } from "./jwt-verify.js";

interface JwksResponse {
  keys: JsonWebKey[];
}

function isJwksResponse(value: unknown): value is JwksResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.keys);
}

const DEFAULT_TTL_MS = 600_000;

/**
 * Build a `JwkResolver` backed by `deps.url`'s JWKS endpoint, fetched via the injected `deps.fetch`
 * and cached by `kid` for `deps.ttlMs` (default 10 minutes), with `deps.now()` as the clock.
 */
export function makeJwksCache(deps: {
  url: string;
  fetch: typeof fetch;
  now: () => number;
  ttlMs?: number;
}): JwkResolver {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const keysByKid = new Map<string, JsonWebKey>();
  let fetchedAt: number | undefined;
  let inFlight: Promise<void> | undefined;

  async function doFetch(): Promise<void> {
    let jwks: JwksResponse;
    try {
      const response = await deps.fetch(deps.url);
      const body: unknown = await response.json();
      if (!isJwksResponse(body)) throw new Error("malformed JWKS response");
      jwks = body;
    } catch {
      throw new JwtError("jwks fetch failed");
    }

    // Never merge a failed/partial fetch into the existing cache - replace it wholesale, on
    // success only, so a bad fetch can't leave stale or half-updated keys sitting in the cache.
    keysByKid.clear();
    for (const key of jwks.keys) {
      const kid = (key as { kid?: unknown }).kid;
      if (typeof kid === "string") keysByKid.set(kid, key);
    }
    fetchedAt = deps.now();
  }

  /** Single-flight: concurrent callers await the same in-flight fetch promise. */
  function fetchOnce(): Promise<void> {
    if (!inFlight) {
      inFlight = doFetch().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  }

  return {
    async resolve(kid: string): Promise<JsonWebKey> {
      const isExpired = fetchedAt === undefined || deps.now() - fetchedAt >= ttlMs;
      if (isExpired || !keysByKid.has(kid)) {
        await fetchOnce();
      }
      const jwk = keysByKid.get(kid);
      if (!jwk) throw new JwtError("unknown key id");
      return jwk;
    },
  };
}
