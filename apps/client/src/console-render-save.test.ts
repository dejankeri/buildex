// Browser test net for the operator console — the Save card's message input (pending.js). The
// prefilled suggestion is derived from FILE NAMES, which an agent can write, so the load-bearing
// assertions are that it only ever lands as an inert attribute value - and that the operator's
// typed name survives the tray's 4s re-render and rides the save POST.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

/** A minimal `/api/sync` response with somewhere to save to and a prefill to offer. */
const sync = (suggestion: string | null = "Updated pricing.md and 2 more in clients/") => ({
  status: "ok",
  unsaved: { files: 3, oldestAt: 1_700_000_000_000, stale: false, connected: true, suggestion },
  signInAvailable: false,
});

describe("console renderers (jsdom) — the save card's message input", () => {
  it("prefills the input with the daemon's suggestion, next to the Save button", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync(), []);
    const card = doc.querySelector("#rpanel .pcard.save")!;
    expect(card).not.toBeNull();
    const input = card.querySelector("#save-msg")!;
    expect(input).not.toBeNull();
    expect(input["value"]).toBe("Updated pricing.md and 2 more in clients/");
    expect(card.querySelector("#save-now")!.textContent).toBe("Save now");
  });

  it("leaves the input empty (placeholder only) when there is no suggestion", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync(null), []);
    const input = doc.querySelector("#save-msg")!;
    expect(input["value"]).toBe("");
    expect(input.getAttribute("placeholder")).toBe("Name this save");
  });

  it("ESCAPES an XSS-y suggestion - it lands as an inert attribute value, never as markup", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync('"><img src=x onerror="alert(1)">.md'), []);
    const card = doc.querySelector("#rpanel .pcard.save")!;
    expect(card.querySelector("img")).toBeNull(); // the payload did NOT become a real element
    expect(doc.querySelector("#save-msg")!["value"]).toBe('"><img src=x onerror="alert(1)">.md');
  });

  it("keeps the operator's typed name across the poll re-render, while an untouched prefill follows a fresh suggestion", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync("Updated a.md"), []);
    // Untouched: a re-render with a newer suggestion may replace the prefill.
    c.renderPending([], sync("Updated a.md and b.md"), []);
    expect(doc.querySelector("#save-msg")!["value"]).toBe("Updated a.md and b.md");
    // Typed: the operator's own words must survive the next poll's re-render.
    (doc.querySelector("#save-msg")! as unknown as { value: string }).value = "Repriced the Pro tier";
    c.renderPending([], sync("Updated a.md and c.md"), []);
    expect(doc.querySelector("#save-msg")!["value"]).toBe("Repriced the Pro tier");
  });

  it("posts the typed message with the save, and omits it when blank", async () => {
    const { w, doc, c } = loadConsole();
    c.S.rightTab = "pending";
    const calls: { url: string; body: unknown }[] = [];
    w["fetch"] = async (url: string, opts?: { body?: string }) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      // One shape serves every route the follow-up rPending() polls, so the re-render after a
      // successful save paints an empty tray instead of throwing mid-poll.
      return {
        ok: true,
        json: async () => ({
          result: "ok", cards: [], conflicts: [], status: "ok", signInAvailable: false,
          unsaved: { files: 0, oldestAt: null, stale: false, connected: true, suggestion: null },
        }),
      };
    };
    c.renderPending([], sync("Updated a.md"), []);
    (doc.querySelector("#save-msg")! as unknown as { value: string }).value = "  Repriced the Pro tier  ";
    doc.querySelector("#save-now")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const save = calls.find((x) => x.url === "/api/sync");
    expect(save).toBeDefined();
    expect(save!.body).toEqual({ message: "Repriced the Pro tier" });

    calls.length = 0;
    c.renderPending([], sync("Updated a.md"), []);
    (doc.querySelector("#save-msg")! as unknown as { value: string }).value = "   ";
    doc.querySelector("#save-now")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.find((x) => x.url === "/api/sync")!.body).toEqual({});
  });

  it("shows no message input on the not-connected card - there is nowhere to save to yet", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    const s = sync();
    s.unsaved.connected = false;
    c.renderPending([], s, []);
    expect(doc.querySelector("#save-msg")).toBeNull();
    expect(doc.querySelector("#save-now")).toBeNull();
  });
});
