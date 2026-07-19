import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlackConnector } from "./slack.js";
import { createNotionConnector } from "./notion.js";
import { runConnectorSync } from "../framework.js";

let ws: string;
beforeEach(() => (ws = mkdtempSync(join(tmpdir(), "buildex-cat-"))));
afterEach(() => rmSync(ws, { recursive: true, force: true }));
const now = () => Date.parse("2026-07-16T12:00:00Z");

describe("Slack connector", () => {
  it("files messages grouped by channel with provenance", async () => {
    const slack = createSlackConnector({
      list: async () => [
        { id: "msg1", channel: "general", user: "dan", text: "shipping today", ts: "2026-07-16T10:00:00Z" },
        { id: "msg2", channel: "general", user: "sam", text: "nice", ts: "2026-07-16T10:01:00Z" },
      ],
    });
    const res = await runConnectorSync(slack, { workspaceDir: ws, now });
    const doc = readFileSync(join(ws, "sources", "slack", "general.md"), "utf8");
    expect(doc).toContain("source: slack");
    expect(doc).toContain("shipping today");
    expect(doc).toContain("nice");
    expect(res.watermark).toBe("2026-07-16T10:01:00Z");
  });
});

describe("Notion connector", () => {
  it("files each page under sources/notion/ with provenance", async () => {
    const notion = createNotionConnector({
      list: async () => [
        { id: "p1", title: "Roadmap", markdown: "# Roadmap\n\n- ship v1", editedAt: "2026-07-16T09:00:00Z", url: "https://notion.so/p1" },
      ],
    });
    const res = await runConnectorSync(notion, { workspaceDir: ws, now });
    const doc = readFileSync(join(ws, "sources", "notion", "p1.md"), "utf8");
    expect(doc).toContain("source: notion");
    expect(doc).toContain("id: p1");
    expect(doc).toContain("ship v1");
    expect(existsSync(join(ws, "sources", "notion", "STATUS.md"))).toBe(true);
    expect(res.watermark).toBe("2026-07-16T09:00:00Z");
  });
});
