// Hermetic tests for verifyJwt: we mint our own RSA/EC keypairs and sign tokens ourselves with
// node:crypto, so no network and no third-party JWT library is ever involved.
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { KeyObject, JsonWebKey } from "node:crypto";
import { verifyJwt, JwtError } from "./jwt-verify.js";
import type { JwkResolver, VerifyConfig } from "./jwt-verify.js";

const ISSUER = "https://project.supabase.co/auth/v1";
const AUDIENCE = "authenticated";
const NOW_MS = 1_700_000_000_000; // fixed clock for deterministic exp/nbf tests
const now = () => NOW_MS;

const CONFIG: VerifyConfig = { issuer: ISSUER, audience: AUDIENCE };

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

interface SignedToken {
  token: string;
  jwk: JsonWebKey;
  kid: string;
}

/** Build+sign a JWT with an arbitrary header/payload, using the given private key + alg. */
function makeToken(
  privateKey: KeyObject,
  publicJwk: JsonWebKey,
  opts: {
    kid?: string;
    alg?: string;
    payload?: Record<string, unknown>;
    signAlg?: "RSA-SHA256" | "sha256";
    dsaEncoding?: "ieee-p1363";
  } = {},
): SignedToken {
  const kid = opts.kid ?? "test-key-1";
  const alg = opts.alg ?? "RS256";
  const header = { alg, typ: "JWT", kid };
  const payload = {
    sub: "user-123",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(NOW_MS / 1000) + 3600,
    iat: Math.floor(NOW_MS / 1000) - 60,
    ...opts.payload,
  };

  const headerSeg = b64url(JSON.stringify(header));
  const payloadSeg = b64url(JSON.stringify(payload));
  const signingInput = `${headerSeg}.${payloadSeg}`;

  const signAlg = opts.signAlg ?? "RSA-SHA256";
  const sig = opts.dsaEncoding
    ? cryptoSign(signAlg, Buffer.from(signingInput), { key: privateKey, dsaEncoding: opts.dsaEncoding })
    : cryptoSign(signAlg, Buffer.from(signingInput), privateKey);

  const token = `${signingInput}.${b64url(sig)}`;
  return { token, jwk: { ...publicJwk, kid }, kid };
}

function makeResolver(jwk: JsonWebKey): JwkResolver {
  return {
    resolve: async (kid: string) => {
      if (kid !== jwk.kid) throw new JwtError("unknown kid");
      return jwk;
    },
  };
}

function generateRsaPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  return { publicKey, privateKey, jwk };
}

function generateEcPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  return { publicKey, privateKey, jwk };
}

describe("verifyJwt (RS256)", () => {
  it("returns claims for a validly signed token", async () => {
    const { privateKey, jwk } = generateRsaPair();
    const { token } = makeToken(privateKey, jwk);
    const keys = makeResolver({ ...jwk, kid: "test-key-1" });

    const claims = await verifyJwt(token, { keys, now, config: CONFIG });

    expect(claims.sub).toBe("user-123");
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(AUDIENCE);
  });

  it("rejects a token whose payload was tampered with after signing", async () => {
    const { privateKey, jwk } = generateRsaPair();
    const { token } = makeToken(privateKey, jwk);
    const keys = makeResolver({ ...jwk, kid: "test-key-1" });

    const [headerSeg, , sigSeg] = token.split(".");
    const tamperedPayload = b64url(JSON.stringify({ sub: "attacker", iss: ISSUER, aud: AUDIENCE, exp: 9_999_999_999 }));
    const tampered = `${headerSeg}.${tamperedPayload}.${sigSeg}`;

    await expect(verifyJwt(tampered, { keys, now, config: CONFIG })).rejects.toThrow(JwtError);
  });

  it("rejects a token with the wrong issuer", async () => {
    const { privateKey, jwk } = generateRsaPair();
    const { token } = makeToken(privateKey, jwk, { payload: { iss: "https://evil.example.com" } });
    const keys = makeResolver({ ...jwk, kid: "test-key-1" });

    await expect(verifyJwt(token, { keys, now, config: CONFIG })).rejects.toThrow(JwtError);
  });

  it("rejects a token whose audience does not match", async () => {
    const { privateKey, jwk } = generateRsaPair();
    const { token } = makeToken(privateKey, jwk, { payload: { aud: "some-other-audience" } });
    const keys = makeResolver({ ...jwk, kid: "test-key-1" });

    await expect(verifyJwt(token, { keys, now, config: CONFIG })).rejects.toThrow(JwtError);
  });

  it("accepts aud as an array containing the configured audience", async () => {
    const { privateKey, jwk } = generateRsaPair();
    const { token } = makeToken(privateKey, jwk, { payload: { aud: ["other", AUDIENCE] } });
    const keys = makeResolver({ ...jwk, kid: "test-key-1" });

    const claims = await verifyJwt(token, { keys, now, config: CONFIG });
    expect(claims.aud).toEqual(["other", AUDIENCE]);
  });

  it("rejects an expired token (fixed clock)", async () => {
    const { privateKey, jwk } = generateRsaPair();
    const { token } = makeToken(privateKey, jwk, {
      payload: { exp: Math.floor(NOW_MS / 1000) - 10 },
    });
    const keys = makeResolver({ ...jwk, kid: "test-key-1" });

    await expect(verifyJwt(token, { keys, now, config: CONFIG })).rejects.toThrow(JwtError);
  });

  it("rejects a token that is not yet valid (nbf in the future)", async () => {
    const { privateKey, jwk } = generateRsaPair();
    const { token } = makeToken(privateKey, jwk, {
      payload: { nbf: Math.floor(NOW_MS / 1000) + 3600 },
    });
    const keys = makeResolver({ ...jwk, kid: "test-key-1" });

    await expect(verifyJwt(token, { keys, now, config: CONFIG })).rejects.toThrow(JwtError);
  });

  it("rejects alg:none outright, never trusting the header to pick 'no signature' - isolated from the empty-signature check via a well-formed, non-empty signature segment", async () => {
    const { privateKey, jwk } = generateRsaPair();
    // Deliberately well-formed and non-empty (a real RSA signature over the signing input) so this
    // test proves the alg allow-list is doing the rejecting, not the separate empty-signature check.
    const { token } = makeToken(privateKey, jwk, { alg: "none" });
    const keys = makeResolver({ ...jwk, kid: "test-key-1" });

    await expect(verifyJwt(token, { keys, now, config: CONFIG })).rejects.toThrow(JwtError);
  });

  it("rejects an unsupported alg (e.g. HS256) even if otherwise well-formed - isolated from the empty-signature check via a well-formed, non-empty signature segment", async () => {
    const { privateKey, jwk } = generateRsaPair();
    const { token } = makeToken(privateKey, jwk, { alg: "HS256" });
    const keys = makeResolver({ ...jwk, kid: "test-key-1" });

    await expect(verifyJwt(token, { keys, now, config: CONFIG })).rejects.toThrow(JwtError);
  });

  it("wraps a raw resolver error (e.g. JWKS fetch/network failure) as JwtError, never letting it escape as-is", async () => {
    const { privateKey, jwk } = generateRsaPair();
    const { token } = makeToken(privateKey, jwk);
    const keys: JwkResolver = {
      resolve: async () => {
        throw new Error("network down");
      },
    };

    await expect(verifyJwt(token, { keys, now, config: CONFIG })).rejects.toThrow(JwtError);
  });

  it("rejects malformed tokens (wrong number of segments) without an uncaught throw", async () => {
    const keys = makeResolver({ kid: "test-key-1" } as JsonWebKey);
    await expect(verifyJwt("not-a-jwt", { keys, now, config: CONFIG })).rejects.toThrow(JwtError);
  });
});

describe("verifyJwt (ES256)", () => {
  it("verifies a raw r||s ES256 signature (ieee-p1363), not DER", async () => {
    const { privateKey, jwk } = generateEcPair();
    const { token } = makeToken(privateKey, jwk, {
      alg: "ES256",
      signAlg: "sha256",
      dsaEncoding: "ieee-p1363",
    });
    const keys = makeResolver({ ...jwk, kid: "test-key-1" });

    const claims = await verifyJwt(token, { keys, now, config: CONFIG });
    expect(claims.sub).toBe("user-123");
  });
});
