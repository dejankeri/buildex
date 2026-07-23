import { describe, it, expect } from "vitest";
import { parseArgs } from "./cli-args.js";

describe("parseArgs - runDeterministic's CLI contract", () => {
  it("parses the sandbox-lane defaults", () => {
    expect(parseArgs(["--pack", "acme"])).toEqual({ pack: "acme", sandbox: true, agent: true, mcpUrl: undefined });
  });

  it("parses --no-sandbox and --no-agent", () => {
    expect(parseArgs(["--pack", "acme", "--no-sandbox", "--no-agent"])).toEqual({ pack: "acme", sandbox: false, agent: false, mcpUrl: undefined });
  });

  it("rejects a missing --pack", () => {
    expect(() => parseArgs([])).toThrow(/--pack/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--pack", "acme", "--frobnicate"])).toThrow(/unknown flag/i);
  });

  describe("--prompt (override the smoke prompt for one run)", () => {
    it("passes the prompt through", () => {
      expect(parseArgs(["--pack", "acme", "--prompt", "List the clients and count them."]).prompt).toBe("List the clients and count them.");
    });

    it("defaults to undefined - the CLI falls back to the built-in smoke prompt", () => {
      expect(parseArgs(["--pack", "acme"]).prompt).toBeUndefined();
    });

    it("rejects an empty prompt", () => {
      expect(() => parseArgs(["--pack", "acme", "--prompt", ""])).toThrow(/--prompt/i);
    });
  });

  describe("flag-shaped values (a forgotten value must be a usage error, not a silent misparse)", () => {
    it("rejects --pack followed by another flag", () => {
      expect(() => parseArgs(["--pack", "--no-sandbox"])).toThrow(/--pack/);
    });

    it("rejects --prompt followed by another flag - it must not eat the mode flag AND drive with a garbage prompt", () => {
      expect(() => parseArgs(["--pack", "acme", "--prompt", "--no-sandbox"])).toThrow(/--prompt/);
    });

    it("rejects --pack/--prompt at the end of argv (missing value)", () => {
      expect(() => parseArgs(["--pack"])).toThrow(/--pack/);
      expect(() => parseArgs(["--pack", "acme", "--prompt"])).toThrow(/--prompt/);
    });
  });

  describe("--mcp-url (the local lane)", () => {
    it("accepts http on [::1] - IPv6 loopback is still loopback", () => {
      expect(parseArgs(["--pack", "acme", "--mcp-url", "http://[::1]:3010/mcp"]).mcpUrl).toBe("http://[::1]:3010/mcp");
    });

    it("names the missing scheme when given host:port/path (which the URL parser would misread as a scheme)", () => {
      expect(() => parseArgs(["--pack", "acme", "--mcp-url", "localhost:3010/mcp"])).toThrow(/scheme|https?:\/\//i);
    });

    it("accepts an https url and turns the sandbox lane off", () => {
      expect(parseArgs(["--pack", "acme", "--mcp-url", "https://api.example.com/mcp"]))
        .toEqual({ pack: "acme", sandbox: false, agent: true, mcpUrl: "https://api.example.com/mcp" });
    });

    it("accepts http on localhost and 127.0.0.1 - the lane exists for local instances", () => {
      expect(parseArgs(["--pack", "acme", "--mcp-url", "http://localhost:3010/mcp"]).mcpUrl).toBe("http://localhost:3010/mcp");
      expect(parseArgs(["--pack", "acme", "--mcp-url", "http://127.0.0.1:8080/mcp"]).mcpUrl).toBe("http://127.0.0.1:8080/mcp");
    });

    it("rejects plain http to a remote host", () => {
      expect(() => parseArgs(["--pack", "acme", "--mcp-url", "http://api.example.com/mcp"])).toThrow(/https/i);
    });

    it("rejects a hostname that merely STARTS with localhost", () => {
      expect(() => parseArgs(["--pack", "acme", "--mcp-url", "http://localhost.evil.com/mcp"])).toThrow(/https/i);
    });

    it("rejects a non-url value", () => {
      expect(() => parseArgs(["--pack", "acme", "--mcp-url", "not a url"])).toThrow(/--mcp-url/i);
    });

    it("rejects combining --mcp-url with --no-sandbox - the local lane already skips the sandbox", () => {
      expect(() => parseArgs(["--pack", "acme", "--mcp-url", "http://localhost:3010/mcp", "--no-sandbox"])).toThrow(/--no-sandbox/);
      expect(() => parseArgs(["--pack", "acme", "--no-sandbox", "--mcp-url", "http://localhost:3010/mcp"])).toThrow(/--no-sandbox/);
    });
  });
});
