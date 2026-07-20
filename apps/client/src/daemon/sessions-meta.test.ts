import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "./sessions.js";
import { sessionTitle } from "./daemon.js";

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

// A conversation's name is the operator's main handle on it in the left rail. A hard mid-word slice
// reads like a bug, so the title is cut at a word boundary - deterministically, with no model call
// (invariant 9: trust surfaces render from repo state with zero LLM).
describe("sessionTitle", () => {
  it("leaves a short first message alone", () => {
    expect(sessionTitle("What is our runway?")).toBe("What is our runway?");
  });

  it("prefers the first sentence when the message runs on", () => {
    expect(sessionTitle("Fix the payroll bug. Then tell me why it happened and who noticed.")).toBe("Fix the payroll bug.");
  });

  it("strips markdown noise so the rail shows prose, not syntax", () => {
    expect(sessionTitle("**Fix** the `payroll` bug")).toBe("Fix the payroll bug");
  });

  it("cuts a long single sentence at a word boundary, never mid-word", () => {
    const t = sessionTitle("Can you check whether the third quarter invoices were reconciled properly");
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/\s…$/); // no dangling space before the ellipsis
    expect(t.length).toBeLessThanOrEqual(49);
    // whatever we kept is a real prefix of the message, ending on a whole word
    const kept = t.slice(0, -1);
    expect("Can you check whether the third quarter invoices were reconciled properly").toContain(kept);
    expect(kept.endsWith("invoices") || kept.endsWith("were") || kept.endsWith("quarter")).toBe(true);
  });

  it("falls back to a usable title for an all-whitespace message", () => {
    expect(sessionTitle("   ")).toBe("New chat");
  });

  it("collapses newlines rather than titling a session with a paragraph", () => {
    expect(sessionTitle("line one\nline two")).toBe("line one line two");
  });
});
