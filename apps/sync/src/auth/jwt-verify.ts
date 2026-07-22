// Verifies a Supabase-issued JWT using only node:crypto - apps/sync ships zero npm dependencies,
// so no `jose` or similar library. RS256 and ES256 only; `alg` is never trusted to pick a key type
// until it has been checked against that allow-list. Every failure throws JwtError with a distinct
// reason so callers (and logs) can tell what went wrong without a stack dive.
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

/** Claims we actually rely on elsewhere; unknown/extra claims in the token are ignored. */
export interface JwtClaims {
  sub: string;
  email?: string;
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat?: number;
}

/** Thrown for every verification failure - bad shape, bad signature, or a failed claim check. */
export class JwtError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "JwtError";
  }
}

/** Resolves a JWK by `kid` (e.g. from Supabase's JWKS endpoint, cached by the caller). */
export interface JwkResolver {
  resolve(kid: string): Promise<JsonWebKey>;
}

export interface VerifyConfig {
  issuer: string;
  audience: string;
}

const ALLOWED_ALGS = new Set(["RS256", "ES256"]);

interface JwtHeader {
  alg: string;
  kid: string;
}

function base64urlDecode(segment: string): Buffer {
  return Buffer.from(segment, "base64url");
}

function parseJsonSegment<T>(segment: string, what: string): T {
  let text: string;
  try {
    text = base64urlDecode(segment).toString("utf8");
  } catch {
    throw new JwtError(`malformed ${what} encoding`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new JwtError(`malformed ${what} JSON`);
  }
}

function isJwtHeader(value: unknown): value is JwtHeader {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  return typeof h.alg === "string" && typeof h.kid === "string";
}

function isJwtClaims(value: unknown): value is JwtClaims {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.sub !== "string") return false;
  if (typeof c.iss !== "string") return false;
  if (typeof c.exp !== "number") return false;
  if (typeof c.aud !== "string" && !Array.isArray(c.aud)) return false;
  if (c.nbf !== undefined && typeof c.nbf !== "number") return false;
  return true;
}

/**
 * Verify `token` against `deps.config` (issuer + audience), resolving the signing key via
 * `deps.keys` and treating `deps.now()` as the current time (ms since epoch, for testability).
 * Resolves with the parsed claims on success; throws JwtError on any failure.
 */
export async function verifyJwt(
  token: string,
  deps: { keys: JwkResolver; now: () => number; config: VerifyConfig },
): Promise<JwtClaims> {
  const segments = token.split(".");
  if (segments.length !== 3) throw new JwtError("malformed token: expected 3 segments");
  const [headerSeg, payloadSeg, sigSeg] = segments as [string, string, string];

  const header = parseJsonSegment<unknown>(headerSeg, "header");
  if (!isJwtHeader(header)) throw new JwtError("malformed header: missing alg/kid");

  // Never let the token's own `alg` pick a key type before it's checked against the allow-list -
  // this is what stops an `alg:"none"` (or any other unsupported alg) token from being accepted.
  if (!ALLOWED_ALGS.has(header.alg)) throw new JwtError(`unsupported alg: ${header.alg}`);

  const claims = parseJsonSegment<unknown>(payloadSeg, "payload");
  if (!isJwtClaims(claims)) throw new JwtError("malformed payload: missing required claims");

  let signature: Buffer;
  try {
    signature = base64urlDecode(sigSeg);
  } catch {
    throw new JwtError("malformed signature encoding");
  }
  if (signature.length === 0) throw new JwtError("missing signature");

  let jwk: JsonWebKey;
  try {
    jwk = await deps.keys.resolve(header.kid);
  } catch (e) {
    throw e instanceof JwtError ? e : new JwtError("key resolution failed");
  }

  let publicKey;
  try {
    publicKey = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    throw new JwtError("could not build public key from JWK");
  }

  // Sign/verify over the ASCII bytes of "header.payload" (the two base64url segments joined by
  // '.'), never over the decoded header/payload bytes.
  const signingInput = Buffer.from(`${headerSeg}.${payloadSeg}`, "ascii");

  // Dispatch explicitly on `alg` - no implicit "anything else = ES256" fallthrough. The allow-list
  // check above already rejects unsupported algs, but this keeps that guard from being the SOLE
  // gate: an alg that somehow slipped past it still can't ride into either verify branch silently.
  let signatureValid: boolean;
  try {
    if (header.alg === "RS256") {
      signatureValid = cryptoVerify("RSA-SHA256", signingInput, publicKey, signature);
    } else if (header.alg === "ES256") {
      // ES256 JWT signatures are raw r||s (64 bytes for P-256), not the DER Node expects by
      // default - dsaEncoding: "ieee-p1363" is required or verification silently fails.
      signatureValid = cryptoVerify(
        "SHA256",
        signingInput,
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        signature,
      );
    } else {
      // Unreachable given the allow-list check above, but no silent fallthrough on our watch.
      throw new JwtError(`unsupported alg: ${header.alg}`);
    }
  } catch (e) {
    throw e instanceof JwtError ? e : new JwtError("signature verification error");
  }
  if (!signatureValid) throw new JwtError("invalid signature");

  if (claims.iss !== deps.config.issuer) throw new JwtError("issuer mismatch");

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(deps.config.audience)) throw new JwtError("audience mismatch");

  const nowMs = deps.now();
  if (claims.exp * 1000 <= nowMs) throw new JwtError("token expired");
  if (claims.nbf !== undefined && claims.nbf * 1000 > nowMs) throw new JwtError("token not yet valid");

  return claims;
}
