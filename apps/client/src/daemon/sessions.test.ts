import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "./sessions.js";

let dir: string;
let store: FileSessionStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-sess-"));
  store = new FileSessionStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FileSessionStore", () => {
  it("creates a session with a uuid id and stores appended events", () => {
    const id = store.create();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    store.append(id, { kind: "text", text: "hi" });
    store.append(id, { kind: "done", sessionId: "x" });
    expect(store.read(id).events.map((e) => e.kind)).toEqual(["text", "done"]);
  });

  it("never exposes the underlying claude session id in read()", () => {
    const id = store.create();
    store.setClaudeSessionId(id, "claude-abc");
    const read = store.read(id) as unknown as Record<string, unknown>;
    expect(read["claudeSessionId"]).toBeUndefined();
    // but the driver can retrieve it internally to resume
    expect(store.getClaudeSessionId(id)).toBe("claude-abc");
  });

  it("rejects a non-uuid id (path-traversal chokepoint)", () => {
    expect(() => store.read("../escape")).toThrow();
    expect(() => store.append("../../etc/passwd", { kind: "text", text: "x" })).toThrow();
  });

  it("persists across store instances", () => {
    const id = store.create();
    store.append(id, { kind: "text", text: "persisted" });
    const reopened = new FileSessionStore(dir);
    expect(reopened.read(id).events).toHaveLength(1);
  });

  it("quarantines a corrupt session file instead of 500ing the whole list", () => {
    const good = store.create();
    store.setTitle(good, "still works");
    // a half-written / corrupt sibling must not take down GET /api/sessions
    writeFileSync(join(dir, "11111111-1111-1111-1111-111111111111.json"), "{ not valid json");
    const list = store.list();
    expect(list.map((s) => s.id)).toEqual([good]); // corrupt one skipped, no throw
  });

  it("ignores a leftover .tmp file from an interrupted atomic write", () => {
    const id = store.create();
    // tmp+rename means a crash can leave `<id>.json.tmp`; list() filters *.json so it's invisible
    writeFileSync(join(dir, `${id}.json.tmp`), "partial");
    expect(store.list().map((s) => s.id)).toEqual([id]);
  });

  it("writes atomically (no half-file is ever observable) - a completed write is valid JSON", () => {
    const id = store.create();
    store.append(id, { kind: "text", text: "a" });
    store.append(id, { kind: "done", sessionId: "s" });
    // after the tmp+rename dance the target is always a fully-formed record
    expect(() => new FileSessionStore(dir).read(id)).not.toThrow();
    expect(new FileSessionStore(dir).read(id).events).toHaveLength(2);
  });
});

// The console replays a thread from these records, so what the store keeps has to be enough to
// render it faithfully: WHO said each thing, and WHEN. Both were missing before the chat-polish
// pass - the console guessed the speaker from turn boundaries and showed no times at all.
describe("FileSessionStore - stored event metadata", () => {
  it("stamps every appended event with its arrival time", () => {
    const clock = { t: 1_700_000_000_000 };
    const s = new FileSessionStore(dir, () => (clock.t += 1000));
    const id = s.create();
    s.append(id, { kind: "text", text: "q", role: "user" });
    s.append(id, { kind: "text", text: "a" });
    const [first, second] = s.read(id).events;
    expect(first!.at).toBe(1_700_000_002_000);
    expect(second!.at).toBe(1_700_000_003_000);
  });

  it("preserves the operator role so replay never has to guess who spoke", () => {
    const id = store.create();
    store.append(id, { kind: "text", text: "what is our runway?", role: "user" });
    store.append(id, { kind: "text", text: "About 14 months." });
    const events = store.read(id).events;
    expect(events[0]!.role).toBe("user");
    expect(events[1]!.role).toBeUndefined();
  });

  it("previews the AGENT's last words, not the operator's own message echoed back", () => {
    const id = store.create();
    store.append(id, { kind: "text", text: "what is our runway?", role: "user" });
    expect(store.list()[0]!.preview).toBeUndefined();
    store.append(id, { kind: "text", text: "About 14 months." });
    expect(store.list()[0]!.preview).toBe("About 14 months.");
    store.append(id, { kind: "text", text: "and after that?", role: "user" });
    expect(store.list()[0]!.preview).toBe("About 14 months."); // unchanged by the operator's turn
  });

  it("still reads a session file written before `at`/`role` existed", () => {
    const id = store.create();
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ id, folder: "Conversations", title: "old", status: "idle", updatedAt: 1, events: [{ kind: "text", text: "legacy" }] }),
    );
    const events = store.read(id).events;
    expect(events[0]!.at).toBeUndefined();
    expect(events[0]!.role).toBeUndefined();
  });
});
