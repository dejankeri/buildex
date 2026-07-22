import { describe, it, expect } from "vitest";
import { gitAuthEnv } from "./credentials.js";

describe("gitAuthEnv", () => {
  it("carries the token as an http.extraHeader Basic credential, never as its own field", () => {
    const env = gitAuthEnv("xmachine_deadbeef");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    // Basic auth, token in the PASSWORD half, username "x" (the server ignores the username).
    const expected = "Authorization: Basic " + Buffer.from("x:xmachine_deadbeef").toString("base64");
    expect(env.GIT_CONFIG_VALUE_0).toBe(expected);
    // The raw token appears in NO key as a bare value - only inside the base64 blob.
    expect(env.GIT_CONFIG_VALUE_0.includes("xmachine_deadbeef")).toBe(false);
  });

  it("decodes back to x:<token> - the exact shape the server's basicPassword() parses", () => {
    const env = gitAuthEnv("xmachine_abc123");
    const b64 = env.GIT_CONFIG_VALUE_0.replace("Authorization: Basic ", "");
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("x:xmachine_abc123");
  });
});
