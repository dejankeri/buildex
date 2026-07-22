// Browser test net for the operator console — the pending approval tray. The console
// renders every surface by building HTML and assigning `.innerHTML` (123 sites); this net loads the
// REAL bundle into jsdom (see console-harness.ts) and asserts renderer DOM output, above all that
// operator/agent-supplied text is ESCAPED not injected - the property the innerHTML→builder migration
// must preserve. Other surfaces live in the sibling console-render-*.test.ts files.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

describe("console renderers (jsdom) — pending approval tray", () => {
  it("renders one card per pending action while the pending tab is active", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([
      { id: "c1", tool: { name: "SendEmail", input: { to: "board@acme.co" } } },
      { id: "c2", tool: { name: "Bash", input: { command: "git push" } } },
    ]);
    expect(doc.querySelectorAll("#rl .pcard")).toHaveLength(2);
    expect(doc.querySelector("#rl .tag")!.textContent).toBe("SendEmail");
    expect(doc.querySelectorAll("#rl .pcard .approve")).toHaveLength(2);
    expect(doc.querySelectorAll("#rl .pcard .dny")).toHaveLength(2);
  });

  it("ESCAPES an XSS-y tool name — the payload is inert text, never a live element", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([{ id: "c1", tool: { name: "<img src=x onerror=alert(1)>", input: { a: "<b>" } } }]);
    expect(doc.querySelector("#rl img")).toBeNull(); // the payload did NOT become a real element
    expect(doc.querySelector("#rl .pcard b")).toBeNull();
    expect(doc.querySelector("#rl .tag")!.textContent).toContain("<img"); // survives as visible text
  });

  it("shows an 'all caught up' state when the queue is empty", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([]);
    expect(doc.querySelector("#rl .rmini")!.textContent).toContain("All caught up");
  });

  it("is a no-op when the pending tab is not the active right-panel view", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "files";
    c.renderPending([{ id: "c1", tool: { name: "X", input: {} } }]);
    expect(doc.querySelector("#rl")).toBeNull(); // #rpanel was never rewritten
  });

  it("humanizes a Skill card as 'Run the <name> skill' and folds the raw request into details", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([{ id: "c1", tool: { name: "Skill", input: { skill: "weekly-review" } } }]);
    expect(doc.querySelector("#rl .pw")!.textContent).toBe("Run the weekly-review skill");
    // The raw JSON is still there, but collapsed inside <details> (not the card's headline).
    const details = doc.querySelector("#rl .pcard details.pd")!;
    expect(details).not.toBeNull();
    expect(details.querySelector("summary")!.textContent).toBe("Show request");
    expect(details.querySelector("pre")!.textContent).toContain("weekly-review");
  });

  it("humanizes a connector email send by its recipient (prefers the gateway summary)", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([
      { id: "c1", tool: { name: "mcp:gmail.send", input: { connector: "gmail", tool: "send", args: { to: "dana@globex.com" } } } },
    ]);
    expect(doc.querySelector("#rl .pw")!.textContent).toBe("Send email to dana@globex.com");
    // A carried summary wins over the generic phrasing.
    c.renderPending([
      { id: "c2", tool: { name: "mcp:gmail.send", input: { summary: "Send email to dana@globex.com — reply on SSO", args: { to: "dana@globex.com" } } } },
    ]);
    expect(doc.querySelector("#rl .pw")!.textContent).toBe("Send email to dana@globex.com — reply on SSO");
  });

  it("humanizes a WebFetch card to its domain and a Bash card to a command chip", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([{ id: "c1", tool: { name: "WebFetch", input: { url: "https://buildex.dev/pricing" } } }]);
    expect(doc.querySelector("#rl .pw")!.textContent).toBe("Fetch buildex.dev");
    c.renderPending([{ id: "c2", tool: { name: "Bash", input: { command: "npm run deploy" } } }]);
    expect(doc.querySelector("#rl .pw")!.textContent).toBe("Run a shell command");
    expect(doc.querySelector("#rl .pcmd code")!.textContent).toBe("npm run deploy");
  });

  it("exposes the tray as a labeled live region and names the approve/deny buttons (a11y, C3)", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([{ id: "c1", tool: { name: "SendEmail", input: {} } }]);
    const region = doc.querySelector("#rl")!;
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-live")).toBe("polite"); // a new approval card is announced
    expect(region.getAttribute("aria-label")).toBe("Pending approvals");
    expect(doc.querySelector("#rl .approve")!.getAttribute("aria-label")).toBe("Approve SendEmail");
    expect(doc.querySelector("#rl .dny")!.getAttribute("aria-label")).toBe("Deny SendEmail");
  });
});

describe("console renderers (jsdom) — the save card", () => {
  /** A /api/sync response shaped like the daemon's. */
  const sync = (unsaved: Record<string, unknown>, status = "ok") => ({ status, unsaved: { oldestAt: null, stale: false, connected: true, ...unsaved } });
  const card = (doc: { querySelector(s: string): { textContent: string | null } | null }) => doc.querySelector("#savecard .pcard.save");

  it("shows no card at all when nothing is waiting", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync({ files: 0 }));
    expect(card(doc)).toBeNull();
    expect(doc.querySelector("#rl")).not.toBeNull(); // the approvals still render
  });

  it("says '1 change' in the singular and '2 changes' in the plural", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync({ files: 1 }));
    expect(card(doc)!.textContent).toContain("1 change ");
    expect(card(doc)!.textContent).not.toContain("changes");
    c.renderPending([], sync({ files: 2 }));
    expect(card(doc)!.textContent).toContain("2 changes");
  });

  it("offers a save only when there is somewhere to save to", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync({ files: 3, connected: true }));
    expect(doc.querySelector("#save-now")).not.toBeNull();

    // No account yet: there's nowhere to save TO automatically, but Phase 3 added a real sign-in
    // surface (js/signin.js), so the card offers a "Sign in" CTA instead of just stating the fact
    // and stopping - "no button" is no longer true now that sign-in is itself an account surface.
    c.renderPending([], sync({ files: 3, connected: false }));
    expect(doc.querySelector("#save-now")).toBeNull();
    expect(doc.querySelector("#signin-now")).not.toBeNull();
    const text = card(doc)!.textContent!;
    expect(text).toContain("saved here and nowhere else");
    expect(text).not.toContain("Connect an account");
    // ...and it agrees with itself grammatically: singular subject, singular pronoun.
    c.renderPending([], sync({ files: 1, connected: false }));
    expect(card(doc)!.textContent).toContain("1 change is saved here and nowhere else. Sign in free to back it up.");
    c.renderPending([], sync({ files: 2, connected: false }));
    expect(card(doc)!.textContent).toContain("2 changes are saved here and nowhere else. Sign in free to back them up.");
  });

  it("escalates to the stakes, not a number, once work has gone stale", () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    const threeDaysAgo = Date.now() - 3 * 86400000;
    c.renderPending([], sync({ files: 4, stale: false }));
    expect(doc.querySelector("#savecard .pcard.save.stale")).toBeNull();
    expect(card(doc)!.textContent).toContain("4 changes");

    c.renderPending([], sync({ files: 4, stale: true, oldestAt: threeDaysAgo }));
    expect(doc.querySelector("#savecard .pcard.save.stale")).not.toBeNull();
    expect(card(doc)!.textContent).toContain("3 days");
    expect(card(doc)!.textContent).toContain("It exists nowhere else.");
  });

  it("leaves the button usable after a failed save, rather than stuck on 'Saving…'", async () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], sync({ files: 2 }));
    const btn = doc.querySelector("#save-now")! as unknown as { click(): void; disabled: boolean; textContent: string };
    expect(btn.textContent).toBe("Save now");
    // The harness's fetch always rejects (no network in renderer tests) - exactly the offline case.
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Save now"); // the operator can try again
  });

  it("does not treat 'no account' as connected just because the status field says ok", () => {
    // The regression this guards: the daemon's status initialises to "ok" and only moves when the
    // operator saves, so deriving connectivity from it made a fresh install look connected forever.
    const { doc, c } = loadConsole();
    c.S.rightTab = "pending";
    c.renderPending([], { status: "ok", unsaved: { files: 3, oldestAt: null, stale: false, connected: false } });
    expect(doc.querySelector("#save-now")).toBeNull();
  });
});

describe("console renderers (jsdom) — sync dot state mapping (syncDotState)", () => {
  // A `/api/sync` response shaped like the daemon's, connected+no-files by default so each test only
  // overrides what it's actually asserting on.
  const resp = (over: Record<string, unknown>) => ({ status: "ok", unsaved: { files: 0, connected: true, ...over } });

  it("needs-help wins outright", () => {
    const { c } = loadConsole();
    expect(c.syncDotState({ status: "needs-help", unsaved: { files: 0, connected: true } })).toBe("help");
  });

  it("queued wins outright", () => {
    const { c } = loadConsole();
    expect(c.syncDotState({ status: "queued", unsaved: { files: 0, connected: true } })).toBe("queued");
  });

  it("the daemon's own 'local' status maps straight through", () => {
    const { c } = loadConsole();
    expect(c.syncDotState({ status: "local", unsaved: { files: 0, connected: true } })).toBe("local");
  });

  it("not connected reads as local EVEN WHEN files are waiting — Finding 1's regression: a fresh " +
    "install (no account) must never read as 'Synced' just because status defaults to ok", () => {
    const { c } = loadConsole();
    expect(c.syncDotState(resp({ connected: false, files: 0 }))).toBe("local");
    expect(c.syncDotState(resp({ connected: false, files: 5 }))).toBe("local");
  });

  it("connected with files waiting reads as unsaved", () => {
    const { c } = loadConsole();
    expect(c.syncDotState(resp({ connected: true, files: 3 }))).toBe("unsaved");
  });

  it("connected with nothing waiting reads as ok", () => {
    const { c } = loadConsole();
    expect(c.syncDotState(resp({ connected: true, files: 0 }))).toBe("ok");
  });
});

describe("console a11y (jsdom) — right-rail tablist", () => {
  it("switchRight keeps the tablist aria-selected in step with the active panel", () => {
    const { doc, c } = loadConsole();
    c.switchRight("files");
    expect(doc.querySelector('#rtabs button[data-r="files"]')!.getAttribute("aria-selected")).toBe("true");
    expect(doc.querySelector('#rtabs button[data-r="pending"]')!.getAttribute("aria-selected")).toBe("false");
    c.switchRight("pending");
    expect(doc.querySelector('#rtabs button[data-r="pending"]')!.getAttribute("aria-selected")).toBe("true");
    expect(doc.querySelector('#rtabs button[data-r="files"]')!.getAttribute("aria-selected")).toBe("false");
  });
});

describe("console renderers (jsdom) — inline chat approvals", () => {
  it("renders an inline Approve/Deny card into the chat thread, humanized from the gateway summary", () => {
    const { c } = loadConsole();
    const thread = c.el("div", { class: "thread" });
    c.injectApproval(
      { thread, sessionId: "s1" },
      { id: "a1", tool: { name: "mcp:stripe.charge", input: { summary: "Charge Jane's card $120" } }, origin: { kind: "chat", sessionId: "s1" } },
    );
    expect(thread.querySelectorAll(".approval")).toHaveLength(1);
    expect(thread.querySelector(".approval .ap-line").textContent).toBe("Charge Jane's card $120");
    expect(thread.querySelector(".approval .approve")).not.toBeNull();
    expect(thread.querySelector(".approval .dny")).not.toBeNull();
  });

  it("is idempotent per card id — a replayed 'open' (reconnect) won't double-render", () => {
    const { c } = loadConsole();
    const thread = c.el("div", {});
    const card = { id: "a2", tool: { name: "Bash", input: { command: "git push --force" } } };
    c.injectApproval({ thread, sessionId: "s" }, card);
    c.injectApproval({ thread, sessionId: "s" }, card);
    expect(thread.querySelectorAll(".approval")).toHaveLength(1);
  });

  it("ESCAPES an XSS-y tool name in an inline card — inert text, never a live element", () => {
    const { c } = loadConsole();
    const thread = c.el("div", {});
    c.injectApproval({ thread, sessionId: "s" }, { id: "a3", tool: { name: "<img src=x onerror=alert(1)>", input: {} } });
    expect(thread.querySelector("img")).toBeNull();
    expect(thread.querySelector(".ap-line").textContent).toContain("<img");
  });
});
