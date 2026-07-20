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
