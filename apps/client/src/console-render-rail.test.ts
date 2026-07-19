// Browser test net for the operator console — the right rail (Files tree), the
// title-bar sync dot, and the middle-column tab bar. Like its sibling console-render.test.ts, this
// loads the REAL bundle into jsdom (see console-harness.ts) and asserts renderer DOM output — above
// all that operator/agent-supplied text (file/dir names, tab titles) is ESCAPED not injected, the
// property the innerHTML→builder migration must preserve.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

describe("console renderers (jsdom) — Files right rail", () => {
  it("renders the tree: a node + row per file and per dir, with the dir's child nested", () => {
    const { doc, c } = loadConsole();
    c.S.tree = [
      { type: "dir", name: "src", children: [{ type: "file", name: "app.ts", path: "src/app.ts" }] },
      { type: "file", name: "README.md", path: "README.md" },
    ];
    c.rFiles(); // builds #rpanel (header, find box, #agenthealth, #tree) then draws the tree
    expect(doc.querySelector("#rpanel .rhead h4")!.textContent).toBe("Files");
    expect(doc.querySelectorAll("#tree .tnode")).toHaveLength(3); // dir + its child file + top-level file
    expect(doc.querySelectorAll("#tree .trow")).toHaveLength(3);
    expect(doc.querySelector("#tree .trow")!.textContent).toContain("src");
    expect(doc.querySelector("#tree img")).toBeNull(); // sanity: benign data, no live elements
  });

  it("shows an empty tree host when there are no files", () => {
    const { doc, c } = loadConsole();
    c.S.tree = [];
    c.rFiles();
    const host = doc.querySelector("#tree")!;
    expect(host).not.toBeNull();
    expect(doc.querySelectorAll("#tree .tnode")).toHaveLength(0);
    expect(host.innerHTML).toBe("");
  });

  it("ESCAPES an XSS-y file name — the payload is inert text, never a live element", () => {
    const { doc, c } = loadConsole();
    c.S.tree = [{ type: "file", name: "<img src=x onerror=alert(1)>", path: "<img src=x onerror=alert(1)>" }];
    c.rFiles();
    expect(doc.querySelector("#tree img")).toBeNull(); // payload did NOT become a real element
    expect(doc.querySelector("#tree .trow")!.textContent).toContain("<img"); // survives as visible text
  });

  it("switchRight('files') marks the Files tab active and renders the Files panel", () => {
    const { doc, c } = loadConsole();
    c.switchRight("files");
    expect(c.S.rightTab).toBe("files");
    expect(doc.querySelector("#rpanel .rhead h4")!.textContent).toBe("Files");
  });
});

describe("console renderers (jsdom) — title-bar sync dot", () => {
  it("paints the requested state class and its tooltip", () => {
    const { doc, c } = loadConsole();
    c.setSync("busy");
    const el = doc.querySelector("#sync")!;
    expect(el.className).toContain("busy");
    expect(el.getAttribute("title")).toContain("Syncing");
    c.setSync("off");
    expect(el.className).toContain("off");
    expect(el.className).not.toContain("busy"); // prior state class was cleared
    expect(el.getAttribute("title")).toContain("Offline");
  });

  it("falls back to 'Synced' for an unknown state", () => {
    const { doc, c } = loadConsole();
    c.setSync("whoknows");
    expect(doc.querySelector("#sync")!.getAttribute("title")).toContain("Synced");
  });
});

describe("console renderers (jsdom) — tab bar", () => {
  it("renders one .tab per open tab, flags the active one, and shows per-type icons", () => {
    const { doc, c } = loadConsole();
    c.S.tabs = [
      { id: "t1", type: "doc", title: "README.md" },
      { id: "t2", type: "chat", title: "Chat", status: "idle" },
    ];
    c.S.active = "t1";
    c.renderTabbar();
    const tabs = doc.querySelectorAll("#tabbar .tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.className).toContain("active");
    expect(tabs[1]!.className).not.toContain("active");
    expect(doc.querySelector("#tabbar .tab .ti")).not.toBeNull(); // doc tab: per-type glyph
    expect(doc.querySelector("#tabbar .tab .st")).not.toBeNull(); // chat tab: live status dot
    expect(doc.querySelector("#tabbar .tab .tt")!.textContent).toBe("README.md");
    expect(doc.querySelector("#tabAdd")).not.toBeNull(); // the add button is preserved
  });

  it("renders no tabs (only the add button) when the tab list is empty", () => {
    const { doc, c } = loadConsole();
    c.S.tabs = [];
    c.renderTabbar();
    expect(doc.querySelectorAll("#tabbar .tab")).toHaveLength(0);
    expect(doc.querySelector("#tabAdd")).not.toBeNull();
  });

  it("ESCAPES an XSS-y tab title — the payload is inert text, never a live element", () => {
    const { doc, c } = loadConsole();
    c.S.tabs = [{ id: "t1", type: "doc", title: "<img src=x onerror=alert(1)>" }];
    c.S.active = "t1";
    c.renderTabbar();
    expect(doc.querySelector("#tabbar img")).toBeNull(); // payload did NOT become a real element
    expect(doc.querySelector("#tabbar .tab .tt")!.textContent).toContain("<img"); // survives as text
  });
});
