// The ledger line is read months later, by a human, off a synced file - so what these tests pin is
// the exact line (format + phrasing + month file), and that the same inputs always produce it.
import { describe, it, expect } from "vitest";
import { ActivityLedger } from "./ledger.js";

// In-memory fs seam: appends accumulate per path, reads return what was appended (hermetic).
function makeLedger(startMs: number) {
  let t = startMs;
  const files = new Map<string, string>();
  const ledger = new ActivityLedger({
    dir: "/team",
    now: () => t,
    appendFile: (path, text) => files.set(path, (files.get(path) ?? "") + text),
    readFile: (path) => files.get(path),
  });
  return { ledger, files, advance: (ms: number) => (t += ms) };
}

const T0 = Date.UTC(2026, 6, 24, 14, 2); // 2026-07-24 14:02 UTC

describe("ActivityLedger.record - one readable line per gated moment", () => {
  it("appends an operator approval as one bullet line in the month file", () => {
    const { ledger, files } = makeLedger(T0);
    ledger.record({
      tool: { name: "mcp:slack.post_message", input: { connector: "slack", tool: "post_message", summary: "post a message to #general" } },
      verdict: "approve",
      reason: "operator",
      origin: { kind: "chat", sessionId: "s1" },
    });
    expect(files.get("/team/activity/2026-07.md")).toBe(
      "- 2026-07-24 14:02 · approved by operator · slack: post a message to #general (chat)\n",
    );
  });

  it("phrases a deliberate deny and a TTL auto-deny differently - the distinction is load-bearing", () => {
    const { ledger, files } = makeLedger(T0);
    ledger.record({ tool: { name: "Bash", input: { command: "git push" } }, verdict: "deny", reason: "operator" });
    ledger.record({
      tool: { name: "mcp:protocol.send_reminder", input: { connector: "protocol", summary: "send a reminder to Dana" } },
      verdict: "deny",
      reason: "timeout",
      origin: { kind: "automation", sessionId: "auto1" },
    });
    expect(files.get("/team/activity/2026-07.md")).toBe(
      "- 2026-07-24 14:02 · denied by operator · run `git push`\n" +
        "- 2026-07-24 14:02 · auto-denied (timed out) · protocol: send a reminder to Dana (automation)\n",
    );
  });

  it("appends newest at the end, never rewriting earlier lines", () => {
    const { ledger, files, advance } = makeLedger(T0);
    ledger.record({ tool: { name: "WebFetch", input: { url: "https://example.com" } }, verdict: "approve", reason: "operator" });
    advance(68 * 60_000); // 15:10
    ledger.record({ tool: { name: "Bash", input: { command: "npm publish" } }, verdict: "deny", reason: "operator" });
    expect(files.get("/team/activity/2026-07.md")!.split("\n").filter(Boolean)).toEqual([
      "- 2026-07-24 14:02 · approved by operator · fetch example.com",
      "- 2026-07-24 15:10 · denied by operator · run `npm publish`",
    ]);
  });

  it("rolls over to a new month file when the clock crosses the month boundary", () => {
    const { ledger, files, advance } = makeLedger(T0);
    ledger.record({ tool: { name: "Bash", input: { command: "a" } }, verdict: "approve", reason: "operator" });
    advance(9 * 24 * 60 * 60_000); // into August
    ledger.record({ tool: { name: "Bash", input: { command: "b" } }, verdict: "approve", reason: "operator" });
    expect(files.has("/team/activity/2026-07.md")).toBe(true);
    expect(files.has("/team/activity/2026-08.md")).toBe(true);
  });

  it("is deterministic: the same resolution at the same instant produces the same line", () => {
    const entry = {
      tool: { name: "mcp:gmail.send", input: { connector: "gmail", tool: "send", args: { to: "ops@acme.com" } } },
      verdict: "approve" as const,
      reason: "operator" as const,
    };
    const a = makeLedger(T0);
    const b = makeLedger(T0);
    a.ledger.record(entry);
    b.ledger.record(entry);
    expect(a.files.get("/team/activity/2026-07.md")).toBe(b.files.get("/team/activity/2026-07.md"));
    expect(a.files.get("/team/activity/2026-07.md")).toContain("gmail: send an email to ops@acme.com");
  });
});

describe("ActivityLedger.recent - the current + previous month, current first", () => {
  it("returns both months' entries when both files exist", () => {
    const { ledger, advance } = makeLedger(Date.UTC(2026, 5, 30, 23, 59)); // June 30
    ledger.record({ tool: { name: "Bash", input: { command: "june" } }, verdict: "approve", reason: "operator" });
    advance(24 * 60 * 60_000); // July 1
    ledger.record({ tool: { name: "Bash", input: { command: "july" } }, verdict: "deny", reason: "operator" });
    expect(ledger.recent()).toEqual([
      { month: "2026-07", entries: ["- 2026-07-01 23:59 · denied by operator · run `july`"] },
      { month: "2026-06", entries: ["- 2026-06-30 23:59 · approved by operator · run `june`"] },
    ]);
  });

  it("skips months with no file, including a January whose previous month is last year's December", () => {
    const { ledger } = makeLedger(Date.UTC(2026, 0, 5));
    expect(ledger.recent()).toEqual([]);
    ledger.record({ tool: { name: "Bash", input: { command: "jan" } }, verdict: "approve", reason: "operator" });
    expect(ledger.recent()).toEqual([{ month: "2026-01", entries: ["- 2026-01-05 00:00 · approved by operator · run `jan`"] }]);
  });
});
