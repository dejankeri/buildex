import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConnectorSync, type Connector } from "./framework.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "buildex-conn-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

/** A well-behaved connector that files two items under its own source dir. */
const goodConnector: Connector = {
  name: "gmail",
  auth: "oauth",
  cadence: "15m",
  filingRecipe: "File each email under sources/gmail/<threadId>.md.",
  async sync(ctx) {
    ctx.writeSource("t-100.md", "Subject: Welcome\n\nHello there.", { source: "gmail", id: "t-100", at: "2026-07-16T10:00:00Z", link: "https://mail/t-100" });
    ctx.writeSource("t-101.md", "Subject: Invoice\n\nSee attached.", { source: "gmail", id: "t-101", at: "2026-07-16T10:05:00Z" });
    return { watermark: "2026-07-16T10:05:00Z", wrote: 2 };
  },
};

const now = () => Date.parse("2026-07-16T10:06:00Z");

describe("runConnectorSync - filing under sources/", () => {
  it("writes each item under sources/<name>/ with provenance frontmatter", async () => {
    await runConnectorSync(goodConnector, { workspaceDir: ws, now });
    const file = join(ws, "sources", "gmail", "t-100.md");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^---\n/);
    expect(text).toContain("source: gmail");
    expect(text).toContain("id: t-100");
    expect(text).toContain("Hello there.");
  });

  it("writes a STATUS.md freshness file", async () => {
    const res = await runConnectorSync(goodConnector, { workspaceDir: ws, now });
    const status = readFileSync(join(ws, "sources", "gmail", "STATUS.md"), "utf8");
    expect(status).toContain("gmail");
    expect(status).toContain("2");
    expect(res.watermark).toBe("2026-07-16T10:05:00Z");
    expect(res.wrote).toBe(2);
  });

  it("passes the prior watermark into sync", async () => {
    let seen: string | undefined;
    const c: Connector = { ...goodConnector, async sync(ctx) { seen = ctx.watermark; return { watermark: "w2", wrote: 0 }; } };
    await runConnectorSync(c, { workspaceDir: ws, now, watermark: "w1" });
    expect(seen).toBe("w1");
  });
});

describe("GATES INVARIANT [release-gate:gates]: a sync run cannot write outside sources/<name>/", () => {
  it("throws and writes nothing outside when a connector attempts to escape", async () => {
    const evil: Connector = {
      ...goodConnector,
      async sync(ctx) {
        ctx.writeSource("../../evil.md", "pwned", { source: "gmail", id: "x", at: "now" });
        return { watermark: "w", wrote: 1 };
      },
    };
    await expect(runConnectorSync(evil, { workspaceDir: ws, now })).rejects.toThrow(/sources/i);
    expect(existsSync(join(ws, "evil.md"))).toBe(false);
    expect(existsSync(join(ws, "sources", "evil.md"))).toBe(false);
  });

  it("rejects an absolute path escape too", async () => {
    const evil: Connector = {
      ...goodConnector,
      async sync(ctx) {
        ctx.writeSource("/tmp/buildex-escape.md", "pwned", { source: "gmail", id: "x", at: "now" });
        return { watermark: "w", wrote: 1 };
      },
    };
    await expect(runConnectorSync(evil, { workspaceDir: ws, now })).rejects.toThrow();
    expect(existsSync("/tmp/buildex-escape.md")).toBe(false);
  });
});
