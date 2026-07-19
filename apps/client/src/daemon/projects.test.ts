import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileProjectStore } from "./projects.js";

let dir: string, store: FileProjectStore;
let seq = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "buildex-proj-"));
  seq = 0;
  store = new FileProjectStore(join(dir, ".projects.json"), () => 1000, () => `id-${++seq}`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FileProjectStore - task containers holding mixed tabs", () => {
  it("creates and lists projects", () => {
    const p = store.create("Globex pilot");
    expect(p).toMatchObject({ id: "id-1", name: "Globex pilot", items: [] });
    expect(store.list()).toHaveLength(1);
  });

  it("adds chat/browser/doc items and de-duplicates by identity", () => {
    const p = store.create("Globex pilot");
    store.addItem(p.id, { type: "chat", sessionId: "s1", title: "kickoff" });
    store.addItem(p.id, { type: "browser", url: "https://globex.com" });
    store.addItem(p.id, { type: "doc", path: "team/globex/profile.md" });
    store.addItem(p.id, { type: "chat", sessionId: "s1", title: "kickoff" }); // dup
    const items = store.get(p.id)!.items;
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.type)).toEqual(["chat", "browser", "doc"]);
  });

  it("renames, removes an item by index, and deletes a project", () => {
    const p = store.create("temp");
    store.addItem(p.id, { type: "browser", url: "https://a.com" });
    store.addItem(p.id, { type: "browser", url: "https://b.com" });
    expect(store.rename(p.id, "renamed").name).toBe("renamed");
    store.removeItem(p.id, 0);
    expect(store.get(p.id)!.items.map((i) => i.url)).toEqual(["https://b.com"]);
    store.remove(p.id);
    expect(store.list()).toHaveLength(0);
  });

  it("throws for an unknown project", () => {
    expect(() => store.addItem("nope", { type: "map" })).toThrow(/not found/i);
  });

  it("de-duplicates app items by repo+name, but distinguishes different names", () => {
    const p = store.create("apps proj");
    store.addItem(p.id, { type: "app", repo: "team", name: "crm-demo" });
    store.addItem(p.id, { type: "app", repo: "team", name: "crm-demo" }); // dup
    expect(store.get(p.id)!.items).toHaveLength(1);
    store.addItem(p.id, { type: "app", repo: "team", name: "other-app" });
    expect(store.get(p.id)!.items).toHaveLength(2);
  });
});
