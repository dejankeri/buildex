import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "./sessions.js";

let dir: string;
let store: FileSessionStore;
let t = 1000;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-sm-"));
  t = 1000;
  store = new FileSessionStore(dir, () => t);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("session metadata + list", () => {
  it("creates with folder + title and lists newest first", () => {
    const a = store.create({ folder: "Acme Labs", title: "Q3 review" });
    t = 2000;
    const b = store.create({ folder: "Acme Labs", title: "Draft update" });
    const list = store.list();
    expect(list.map((s) => s.id)).toEqual([b, a]); // newest first
    expect(list[0]).toMatchObject({ folder: "Acme Labs", title: "Draft update", status: "idle" });
  });

  it("tracks status transitions", () => {
    const id = store.create();
    store.setStatus(id, "running");
    expect(store.read(id).status).toBe("running");
    store.setStatus(id, "idle");
    expect(store.list().find((s) => s.id === id)!.status).toBe("idle");
  });

  it("derives a preview from the last agent text and bumps updatedAt on append", () => {
    const id = store.create();
    t = 3000;
    store.append(id, { kind: "text", text: "Acme's Q3 MRR is $18,400." });
    const s = store.list().find((x) => x.id === id)!;
    expect(s.preview).toContain("18,400");
    expect(s.updatedAt).toBe(3000);
  });

  it("read() still omits the underlying claude session id", () => {
    const id = store.create();
    store.setClaudeSessionId(id, "claude-xyz");
    expect((store.read(id) as unknown as Record<string, unknown>)["claudeSessionId"]).toBeUndefined();
    expect(store.getClaudeSessionId(id)).toBe("claude-xyz");
  });
});
