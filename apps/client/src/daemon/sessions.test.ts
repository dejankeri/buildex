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
