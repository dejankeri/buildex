// Browser-net (jsdom) render tests for the org switcher (B2a). Loads the REAL console bundle and
// drives renderOrgSwitcher directly - no network - asserting the DOM, the sandbox badge/body class,
// the XSS-escaping of an org name, and the graceful empty/hidden path.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

describe("console org switcher (renderOrgSwitcher) [browser-net]", () => {
  it("renders the active org name and its switch menu", () => {
    const { doc, c } = loadConsole();
    c.renderOrgSwitcher({
      orgs: [
        { id: "r1", name: "My Startup", sandbox: false },
        { id: "demo", name: "Acme Labs", sandbox: true },
      ],
      activeId: "r1",
    });
    const bar = doc.querySelector("#orgbar")!;
    expect(bar.getAttribute("hidden")).toBeNull(); // shown
    expect(doc.querySelector(".orgcurrent .orgname")!.textContent).toBe("My Startup");
    // both orgs appear in the menu; the active one is marked
    const items = Array.from(doc.querySelectorAll(".orgitem"));
    expect(items.map((i) => i.querySelector(".orgname")!.textContent)).toEqual(["My Startup", "Acme Labs"]);
    expect(doc.querySelector(".orgitem.on .orgname")!.textContent).toBe("My Startup");
  });

  it("offers a 'clear stored credentials' action that arms on the first tap (two-tap confirm)", () => {
    const { doc, c } = loadConsole();
    c.renderOrgSwitcher({ orgs: [{ id: "r1", name: "Real", sandbox: false }], activeId: "r1" });
    const btn = doc.querySelector(".orgforget")!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Clear stored credentials");
    btn.click(); // first tap only arms - no network, no reload
    expect(btn.textContent).toContain("Tap again");
    expect(btn.className).toContain("armed");
  });

  it("badges the demo as a sandbox and marks the body when it's active", () => {
    const { doc, c } = loadConsole();
    c.renderOrgSwitcher({ orgs: [{ id: "demo", name: "Acme Labs", sandbox: true }], activeId: "demo" });
    // the active-org chip carries the Demo tag, and there's the "never synced" note
    expect(doc.querySelector(".orgcurrent .orgtag")!.textContent).toBe("Demo");
    expect(doc.querySelector(".orgnote")!.textContent).toContain("never synced");
    // <body> flagged so CSS suppresses the sync affordance for a non-syncable org
    expect(doc.querySelector("body")!.className).toContain("sandbox");
  });

  it("does NOT flag the body sandbox when a real org is active", () => {
    const { doc, c } = loadConsole();
    c.renderOrgSwitcher({ orgs: [{ id: "r1", name: "Real", sandbox: false }], activeId: "r1" });
    expect(doc.querySelector("body")!.className).not.toContain("sandbox");
    expect(doc.querySelector(".orgcurrent .orgtag")).toBeNull(); // no Demo tag
  });

  it("escapes an org name - never parses it as markup (XSS canary)", () => {
    const { doc, c } = loadConsole();
    c.renderOrgSwitcher({ orgs: [{ id: "x", name: "<img src=x onerror=alert(1)>", sandbox: false }], activeId: "x" });
    const name = doc.querySelector(".orgcurrent .orgname")!;
    expect(name.querySelector("img")).toBeNull(); // no element was injected
    expect(name.textContent).toBe("<img src=x onerror=alert(1)>"); // it's inert text
  });

  it("hides the switcher when there are no orgs (single-workspace daemon)", () => {
    const { doc, c } = loadConsole();
    c.renderOrgSwitcher({ orgs: [], activeId: "" });
    expect(doc.querySelector("#orgbar")!.getAttribute("hidden")).not.toBeNull();
  });

  it("toggleOrgMenu opens and closes the dropdown", () => {
    const { doc, c } = loadConsole();
    c.renderOrgSwitcher({ orgs: [{ id: "demo", name: "Acme Labs", sandbox: true }], activeId: "demo" });
    const menu = doc.querySelector("#orgmenu")!;
    expect(menu.getAttribute("hidden")).not.toBeNull(); // starts closed
    c.toggleOrgMenu();
    expect(menu.getAttribute("hidden")).toBeNull(); // opened
    c.toggleOrgMenu();
    expect(menu.getAttribute("hidden")).not.toBeNull(); // closed again
  });
});
