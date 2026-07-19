// Token discipline for the sync control plane.
// Adapted from the prototype's proven patterns: hash-at-rest, one-time consumption, TTL,
// timing-safe comparison, and regex-gating any token reflected into a script/URL.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** Prefixes tag a token's role and are used by the regex-gate. */
export const TOKEN_PREFIX = {
  setup: "xsetup_",
  refresh: "xrefresh_",
  machine: "xmachine_",
} as const;

export type TokenPrefix = (typeof TOKEN_PREFIX)[keyof typeof TOKEN_PREFIX];

/** A fresh opaque token: `<prefix>` + 24 random bytes as 48 lowercase hex chars. */
export function newToken(prefix: string): string {
  return prefix + randomBytes(24).toString("hex");
}

/** sha256 hex digest - only this is ever persisted (never the raw token). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time string comparison; length-guarded so it never throws. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True iff `token` is a well-formed token of `prefix`: the exact prefix followed by 32–128
 * lowercase hex chars. Gate anything reflected into a downloadable script or a URL through this
 * to defend against command/parameter injection.
 */
export function isWellFormedToken(prefix: string, token: string): boolean {
  if (!token.startsWith(prefix)) return false;
  const body = token.slice(prefix.length);
  return /^[a-f0-9]{32,128}$/.test(body);
}
