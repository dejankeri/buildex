// Browser test net for the operator console — the kept-work recovery cards in the pending tray
// (pending.js keptCard/viewKept). Kept-file NAMES and CONTENT come from workspace files an agent
// can write, so they are attacker-influenceable: the load-bearing assertions here are that both
// only ever land as inert text. Copy is checked for operator vocabulary - the surface says "we
// kept your version" / "the team's version won", never git's words.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

/** One `/api/conflicts` backup, shaped like the daemon's wire format. */
const backup = (files: { path: string; differs: boolean }[], stamp = "1700000000000") => ({
  root: "team",
  stamp,
  at: Number(stamp),
  files,
});

/** A minimal `/api/sync` response so renderPending also paints (or skips) the save card. */
const sync = { status: "needs-help", unsaved: { files: 0, oldestAt: null, stale: false, connected: true }, signInAvailable: false };

describe("console renderers (jsdom) — kept-work cards", () => {
  it("renders one card per backup, naming the single file, with View + Copy back", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync, [backup([{ path: "plans/q3.md", differs: true }])]);
    const card = doc.querySelector("#rpanel .pcard.kept")!;
    expect(card).not.toBeNull();
    expect(card.querySelector("b")!.textContent).toBe("We kept your version of q3.md");
    expect(card.textContent).toContain("The team's version won");
    expect(card.querySelector(".kname")!.textContent).toBe("plans/q3.md");
    const buttons = Array.from(card.querySelectorAll(".ka button")).map((b) => b.textContent);
    expect(buttons).toEqual(["View", "Copy back"]);
    // Something still differs, so the card must not yet offer to be cleared.
    expect(card.querySelector(".kdismiss")).toBeNull();
    // Operator vocabulary only - git's words never reach this surface.
    expect(card.textContent).not.toMatch(/conflict|merge|rebase|git/i);
  });

  it("counts files in the plural title and renders a row per file", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync, [backup([{ path: "a.md", differs: true }, { path: "b.md", differs: false }])]);
    const card = doc.querySelector("#rpanel .pcard.kept")!;
    expect(card.querySelector("b")!.textContent).toBe("We kept your version of 2 files");
    expect(card.querySelectorAll(".kfile")).toHaveLength(2);
    // The already-matching file says so instead of offering a pointless copy.
    const rows = Array.from(card.querySelectorAll(".kfile"));
    expect(rows[0]!.querySelectorAll("button")).toHaveLength(2);
    expect(rows[1]!.querySelectorAll("button")).toHaveLength(1); // View only
    expect(rows[1]!.querySelector(".kdone")!.textContent).toBe("Same as current");
  });

  it("offers Dismiss ('Got it') once nothing differs any more", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync, [backup([{ path: "a.md", differs: false }])]);
    const card = doc.querySelector("#rpanel .pcard.kept")!;
    expect(card.querySelector(".kdismiss")!.textContent).toBe("Got it");
    expect(card.textContent).toContain("nothing left to copy back");
  });

  it("ESCAPES an XSS-y kept-file name — the payload is inert text, never a live element", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync, [backup([{ path: '<img src=x onerror="alert(1)">.md', differs: true }])]);
    const card = doc.querySelector("#rpanel .pcard.kept")!;
    expect(card.querySelector("img")).toBeNull(); // the payload did NOT become a real element
    expect(card.querySelector(".kname")!.textContent).toContain("<img");
  });

  it("renders several cards, one per backup, and none at all when nothing is kept", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync, [
      backup([{ path: "a.md", differs: true }], "2000"),
      backup([{ path: "b.md", differs: true }], "1000"),
    ]);
    expect(doc.querySelectorAll("#rpanel .pcard.kept")).toHaveLength(2);
    c.renderPending([], sync, []);
    expect(doc.querySelectorAll("#rpanel .pcard.kept")).toHaveLength(0);
  });

  it("falls back to the cached lastConflicts when the render is given none", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.lastConflicts.push(backup([{ path: "cached.md", differs: true }]));
    c.renderPending([], sync);
    expect(doc.querySelector("#rpanel .pcard.kept .kname")!.textContent).toBe("cached.md");
  });

  it("the approvals still render alongside the kept cards", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([{ id: "c1", tool: { name: "SendEmail", input: {} } }], sync, [backup([{ path: "a.md", differs: true }])]);
    expect(doc.querySelector("#rpanel .pcard.kept")).not.toBeNull();
    expect(doc.querySelectorAll("#rl .pcard")).toHaveLength(1);
  });
});

describe("console renderers (jsdom) — the kept-work compare view", () => {
  it("shows both versions read-only, with content escaped, and closes cleanly", async () => {
    const { w, doc, c } = loadConsole();
    // The compare view fetches /api/conflicts/file - hand it a canned response, with an XSS-y body.
    w["fetch"] = async () => ({
      ok: true,
      json: async () => ({ kept: '<script>alert("kept")</script>', current: "<b>current</b>" }),
    });
    await c.viewKept("team", "1700", "plans/q3.md");
    const card = doc.querySelector(".ovbackdrop .ovcard.kview")!;
    expect(card).not.toBeNull();
    expect(card.querySelector(".ovh")!.textContent).toBe("plans/q3.md");
    const heads = Array.from(card.querySelectorAll(".kpane h4")).map((h) => h.textContent);
    expect(heads).toEqual(["Your version (kept)", "Current version"]);
    const pres = Array.from(card.querySelectorAll(".kpane pre"));
    expect(pres[0]!.textContent).toContain("<script>"); // inert text, not a live element
    expect(pres[1]!.textContent).toBe("<b>current</b>");
    expect(card.querySelector("pre script")).toBeNull();
    expect(card.querySelector("pre b")).toBeNull();
    (card.querySelector(".ovno")! as unknown as { click(): void }).click();
    expect(doc.querySelector(".ovbackdrop")).toBeNull();
  });

  it("says so when the current file no longer exists", async () => {
    const { w, doc, c } = loadConsole();
    w["fetch"] = async () => ({ ok: true, json: async () => ({ kept: "kept\n", current: null }) });
    await c.viewKept("team", "1700", "gone.md");
    const pres = Array.from(doc.querySelectorAll(".kpane pre"));
    expect(pres[1]!.textContent).toBe("(this file no longer exists)");
  });
});
