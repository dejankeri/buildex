import { describe, it, expect } from "vitest";
import {
  TOKEN_PREFIX,
  newToken,
  hashToken,
  timingSafeEqualStr,
  isWellFormedToken,
} from "./tokens.js";

describe("newToken", () => {
  it("prefixes the token and appends 48 hex chars (24 random bytes)", () => {
    const t = newToken(TOKEN_PREFIX.setup);
    expect(t.startsWith("xsetup_")).toBe(true);
    expect(t.slice("xsetup_".length)).toMatch(/^[a-f0-9]{48}$/);
  });

  it("never repeats (fresh randomness each call)", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newToken(TOKEN_PREFIX.refresh)));
    expect(seen.size).toBe(200);
  });
});

describe("hashToken (hash-at-rest)", () => {
  it("is a stable sha256 hex digest, not the raw token", () => {
    const t = "xsetup_deadbeef";
    const h = hashToken(t);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).not.toContain(t);
    expect(hashToken(t)).toBe(h); // deterministic
  });

  it("differs for different tokens", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
});

describe("timingSafeEqualStr", () => {
  it("is true for equal strings, false otherwise", () => {
    expect(timingSafeEqualStr("service-key-abc", "service-key-abc")).toBe(true);
    expect(timingSafeEqualStr("service-key-abc", "service-key-xyz")).toBe(false);
  });

  it("is false for different lengths without throwing", () => {
    expect(timingSafeEqualStr("short", "a-much-longer-value")).toBe(false);
  });
});

describe("isWellFormedToken (regex-gate for reflection into scripts/URLs)", () => {
  it("accepts a well-formed token of the given prefix", () => {
    expect(isWellFormedToken(TOKEN_PREFIX.setup, newToken(TOKEN_PREFIX.setup))).toBe(true);
  });

  it("rejects wrong prefix, injection chars, and empties", () => {
    expect(isWellFormedToken(TOKEN_PREFIX.setup, newToken(TOKEN_PREFIX.refresh))).toBe(false);
    expect(isWellFormedToken(TOKEN_PREFIX.setup, "xsetup_abc; rm -rf /")).toBe(false);
    expect(isWellFormedToken(TOKEN_PREFIX.setup, "xsetup_ABCDEF")).toBe(false); // uppercase not hex-lower
    expect(isWellFormedToken(TOKEN_PREFIX.setup, "")).toBe(false);
  });
});
