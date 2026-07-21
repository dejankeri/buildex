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
});
