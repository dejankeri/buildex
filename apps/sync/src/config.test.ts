import { describe, it, expect } from "vitest";
import { readConfig, ConfigError, MIN_SERVICE_KEY_LENGTH } from "./config.js";

const KEY = "k".repeat(MIN_SERVICE_KEY_LENGTH);

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    BUILDEX_SERVICE_KEY: KEY,
    BUILDEX_PUBLIC_BASE_URL: "https://sync.example.test",
    ...over,
  };
}

describe("readConfig", () => {
  it("reads a complete environment", () => {
    const c = readConfig(env({ BUILDEX_DATA_DIR: "/data", PORT: "9000" }));
    expect(c).toEqual({
      serviceKey: KEY,
      publicBaseUrl: "https://sync.example.test",
      dataDir: "/data",
      port: 9000,
    });
  });

  it("defaults the data dir and port", () => {
    const c = readConfig(env());
    expect(c.dataDir).toBe("/srv/buildex");
    expect(c.port).toBe(8080);
  });

  it("strips a trailing slash from the base URL so clone URLs never double up", () => {
    expect(readConfig(env({ BUILDEX_PUBLIC_BASE_URL: "https://sync.example.test/" })).publicBaseUrl).toBe(
      "https://sync.example.test",
    );
  });

  it("requires a service key", () => {
    expect(() => readConfig(env({ BUILDEX_SERVICE_KEY: undefined }))).toThrow(ConfigError);
    expect(() => readConfig(env({ BUILDEX_SERVICE_KEY: "   " }))).toThrow(/required/);
  });

  it("rejects a short service key - it guards company creation on the public internet", () => {
    expect(() => readConfig(env({ BUILDEX_SERVICE_KEY: "short" }))).toThrow(/at least/);
  });

  it("requires an absolute https base URL", () => {
    expect(() => readConfig(env({ BUILDEX_PUBLIC_BASE_URL: undefined }))).toThrow(/required/);
    expect(() => readConfig(env({ BUILDEX_PUBLIC_BASE_URL: "sync.example.test" }))).toThrow(/absolute URL/);
    expect(() => readConfig(env({ BUILDEX_PUBLIC_BASE_URL: "http://sync.example.test" }))).toThrow(/https/);
  });

  it("allows plain http on loopback so a local run needs no certificate", () => {
    expect(readConfig(env({ BUILDEX_PUBLIC_BASE_URL: "http://127.0.0.1:8080" })).publicBaseUrl).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("rejects a non-numeric or out-of-range port", () => {
    expect(() => readConfig(env({ PORT: "eighty" }))).toThrow(/PORT/);
    expect(() => readConfig(env({ PORT: "70000" }))).toThrow(/PORT/);
  });

  it("treats an empty or whitespace-only optional value as absent, not as a value", () => {
    expect(readConfig(env({ BUILDEX_DATA_DIR: "" })).dataDir).toBe("/srv/buildex");
    expect(readConfig(env({ BUILDEX_DATA_DIR: "   " })).dataDir).toBe("/srv/buildex");
    expect(readConfig(env({ PORT: "" })).port).toBe(8080);
    expect(readConfig(env({ PORT: "  " })).port).toBe(8080);
  });

  it("still honours an explicit port 0, which means 'pick an ephemeral port'", () => {
    expect(readConfig(env({ PORT: "0" })).port).toBe(0);
  });

  it("rejects a non-absolute data dir - it would silently land data on the container's ephemeral layer", () => {
    expect(() => readConfig(env({ BUILDEX_DATA_DIR: "srv/buildex" }))).toThrow(ConfigError);
    expect(() => readConfig(env({ BUILDEX_DATA_DIR: "srv/buildex" }))).toThrow(/absolute path/);
    expect(() => readConfig(env({ BUILDEX_DATA_DIR: "./data" }))).toThrow(/absolute path/);
  });

  it("accepts an absolute data dir", () => {
    expect(readConfig(env({ BUILDEX_DATA_DIR: "/srv/buildex" })).dataDir).toBe("/srv/buildex");
    expect(readConfig(env({ BUILDEX_DATA_DIR: "/data/nested" })).dataDir).toBe("/data/nested");
  });

  it("still reads a complete environment when Supabase sign-in is untouched", () => {
    const c = readConfig(env({ BUILDEX_DATA_DIR: "/data", PORT: "9000" }));
    expect(c).toEqual({
      serviceKey: KEY,
      publicBaseUrl: "https://sync.example.test",
      dataDir: "/data",
      port: 9000,
    });
  });

  describe("Supabase sign-in config (dormant unless fully configured)", () => {
    it("leaves signIn undefined when none of the three vars are set", () => {
      expect(readConfig(env()).signIn).toBeUndefined();
    });

    it("sets signIn when all three vars are set", () => {
      const c = readConfig(
        env({
          BUILDEX_SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
          BUILDEX_SUPABASE_ISSUER: "https://project.supabase.co/auth/v1",
          BUILDEX_SUPABASE_AUDIENCE: "authenticated",
        }),
      );
      expect(c.signIn).toEqual({
        jwksUrl: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
        issuer: "https://project.supabase.co/auth/v1",
        audience: "authenticated",
      });
    });

    it("leaves signIn undefined when only two of the three vars are set - no partial config", () => {
      expect(
        readConfig(
          env({
            BUILDEX_SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
            BUILDEX_SUPABASE_ISSUER: "https://project.supabase.co/auth/v1",
          }),
        ).signIn,
      ).toBeUndefined();
      expect(
        readConfig(
          env({
            BUILDEX_SUPABASE_ISSUER: "https://project.supabase.co/auth/v1",
            BUILDEX_SUPABASE_AUDIENCE: "authenticated",
          }),
        ).signIn,
      ).toBeUndefined();
      expect(
        readConfig(
          env({
            BUILDEX_SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
            BUILDEX_SUPABASE_AUDIENCE: "authenticated",
          }),
        ).signIn,
      ).toBeUndefined();
    });

    it("treats an empty or whitespace-only Supabase var as absent, same as the other optionals", () => {
      expect(
        readConfig(
          env({
            BUILDEX_SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
            BUILDEX_SUPABASE_ISSUER: "https://project.supabase.co/auth/v1",
            BUILDEX_SUPABASE_AUDIENCE: "   ",
          }),
        ).signIn,
      ).toBeUndefined();
    });
  });
});
