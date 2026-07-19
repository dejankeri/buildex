import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

// main.cjs is CommonJS Electron plumbing; the one non-trivial decision (external vs. app-internal) is
// extracted here as a pure helper so it can be unit-tested without standing up Electron.
const require = createRequire(import.meta.url);
const { isExternalUrl, sanitizeWebviewSrc } = require("./external-url.cjs") as {
  isExternalUrl: (url: string, appOrigin: string) => boolean;
  sanitizeWebviewSrc: (src: unknown) => string;
};

const APP = "http://127.0.0.1:4317";

describe("isExternalUrl - hand external links to the OS browser, keep the app on its loopback origin", () => {
  it("treats a provider authorize URL as external (→ opens in the real browser)", () => {
    expect(isExternalUrl("https://accounts.google.com/o/oauth2/auth?scope=x", APP)).toBe(true);
  });

  it("keeps the app's OWN loopback origin internal - incl. the OAuth callback path", () => {
    // the redirect lands in the external browser; but were the app to see it, it must NOT be treated
    // as a link to fling back out - same origin stays in-window.
    expect(isExternalUrl("http://127.0.0.1:4317/oauth/gmail/callback?code=abc", APP)).toBe(false);
    expect(isExternalUrl("http://127.0.0.1:4317/", APP)).toBe(false);
  });

  it("treats a different loopback port as external (another worktree / the gateway)", () => {
    expect(isExternalUrl("http://127.0.0.1:4318/mcp", APP)).toBe(true);
  });

  it("ignores non-http(s) schemes (never openExternal a file:/javascript: URL)", () => {
    expect(isExternalUrl("file:///etc/passwd", APP)).toBe(false);
    expect(isExternalUrl("javascript:alert(1)", APP)).toBe(false);
    expect(isExternalUrl("", APP)).toBe(false);
  });

  it("is robust to a per-worktree app origin (isolated ports)", () => {
    expect(isExternalUrl("https://mcp.notion.com/authorize", "http://127.0.0.1:4402")).toBe(true);
    expect(isExternalUrl("http://127.0.0.1:4402/", "http://127.0.0.1:4402")).toBe(false);
  });
});

describe("sanitizeWebviewSrc - a <webview> guest may only ever load real web content", () => {
  it("passes http(s) URLs through unchanged", () => {
    expect(sanitizeWebviewSrc("https://app.notion.so")).toBe("https://app.notion.so");
    expect(sanitizeWebviewSrc("http://example.com/x?y=1")).toBe("http://example.com/x?y=1");
  });

  it("forces any non-http(s) or malformed src to about:blank (no local/privileged schemes)", () => {
    expect(sanitizeWebviewSrc("file:///etc/passwd")).toBe("about:blank");
    expect(sanitizeWebviewSrc("chrome://settings")).toBe("about:blank");
    expect(sanitizeWebviewSrc("javascript:alert(1)")).toBe("about:blank");
    expect(sanitizeWebviewSrc("about:blank")).toBe("about:blank");
    expect(sanitizeWebviewSrc("")).toBe("about:blank");
    expect(sanitizeWebviewSrc(undefined)).toBe("about:blank");
    expect(sanitizeWebviewSrc(null)).toBe("about:blank");
    expect(sanitizeWebviewSrc(42)).toBe("about:blank");
  });
});
