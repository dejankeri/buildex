import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGmailConnector, type GmailMessage } from "./gmail.js";
import { runConnectorSync } from "../framework.js";

let ws: string;
beforeEach(() => (ws = mkdtempSync(join(tmpdir(), "buildex-gmail-"))));
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const FIXTURE: GmailMessage[] = [
  { id: "m1", threadId: "t1", from: "ceo@partner.com", subject: "Kickoff next week", date: "2026-07-16T10:00:00Z", body: "Let's start Monday.", link: "https://mail.google.com/t1" },
  { id: "m2", threadId: "t2", from: "billing@vendor.com", subject: "Invoice #204", date: "2026-07-16T11:00:00Z", body: "Amount due: $1,200." },
];
const now = () => Date.parse("2026-07-16T11:30:00Z");

describe("Gmail connector (fixture-based, hermetic)", () => {
  it("files each message under sources/gmail/ with provenance and returns the latest watermark", async () => {
    const gmail = createGmailConnector({ list: async () => FIXTURE });
    const res = await runConnectorSync(gmail, { workspaceDir: ws, now });

    const t1 = readFileSync(join(ws, "sources", "gmail", "t1.md"), "utf8");
    expect(t1).toContain("source: gmail");
    expect(t1).toContain("id: m1");
    expect(t1).toContain("ceo@partner.com");
    expect(t1).toContain("Kickoff next week");
    expect(t1).toContain("Let's start Monday.");

    expect(res.wrote).toBe(2);
    expect(res.watermark).toBe("2026-07-16T11:00:00Z");
  });

  it("passes the prior watermark to the list call (incremental sync)", async () => {
    let since: string | undefined;
    const gmail = createGmailConnector({ list: async (s) => { since = s; return []; } });
    await runConnectorSync(gmail, { workspaceDir: ws, now, watermark: "2026-07-16T09:00:00Z" });
    expect(since).toBe("2026-07-16T09:00:00Z");
  });

  it("declares oauth auth and ships a filing recipe", () => {
    const gmail = createGmailConnector({ list: async () => [] });
    expect(gmail.auth).toBe("oauth");
    expect(gmail.filingRecipe.length).toBeGreaterThan(0);
  });
});
