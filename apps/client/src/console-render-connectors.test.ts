// Browser test net for the operator console — the connectors + apps surfaces. These
// carry the console's densest innerHTML builders (connectors.js: 24 sites, apps.js: 6), so they are
// the highest-value surface to pin: real bundle loaded into jsdom (see console-harness.ts), renderer
// DOM output asserted, and above all that provider names / URLs / tool names / statuses coming from
// config or the agent are ESCAPED not injected — the property the innerHTML→builder migration must
// preserve. Sibling surfaces live in the other console-render-*.test.ts files.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

// The connector/apps renderers fetch their own data (getJSON/postJSON). The shared harness stubs
// `fetch` to reject; here we route it to controlled JSON so the inner render path runs deterministically
// — still no real network, still synchronous (the promises resolve on the microtask queue we await).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routeFetch(w: any, routes: Array<[string, unknown]>): void {
  w.fetch = (url: string) => {
    for (const [pat, data] of routes) {
      if (String(url).includes(pat)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    }
    return Promise.reject(new Error("no route: " + url));
  };
}

const XSS = "<img src=x onerror=alert(1)>";

describe("console renderers (jsdom) — apps left rail (refreshApps)", () => {
  it("paints one row per app (Store lives in the header now) with an AI button + open-interface button", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/apps", { apps: [
        { repo: "team", name: "protocol", title: "Protocol", kind: "external", icon: "🌐" },
        { repo: "team", name: "notion", title: "Notion", kind: "local" },
      ] }],
      ["/api/connectors/gateway", { status: [
        { name: "protocol", needsAuth: true, authUrl: "https://auth.example.com" },
        { name: "notion", connected: true },
      ] }],
    ]);
    await c.refreshApps();
    // Two app rows, NO Store row (Store moved into the section header).
    expect(doc.querySelectorAll("#applist .aitem")).toHaveLength(2);
    expect(doc.querySelector("#applist .astore")).toBeNull();
    // Each row has an AI button and a 🌐 open-interface button (the row itself isn't clickable).
    expect(doc.querySelectorAll("#applist .aiapp")).toHaveLength(2);
    expect(doc.querySelectorAll("#applist .aweb")).toHaveLength(2);
    // needsAuth app → AI button in the "off" (not-connected) state; connected app → a plain AI button.
    const off = doc.querySelector("#applist .aiapp.off");
    expect(off).not.toBeNull();
    expect(off!.textContent).toContain("not connected");
    expect(doc.querySelectorAll("#applist .aiapp:not(.off)")).toHaveLength(1); // notion (connected)
    expect(doc.querySelectorAll("#applist .albl")[0]!.textContent).toBe("Protocol");
  });

  it("an app whose tools need no gateway auth shows a ready AI button, not 'not connected'", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/apps", { apps: [{ repo: "team", name: "gmail", title: "Gmail", kind: "local" }] }],
      ["/api/connectors/gateway", { status: [] }], // no gateway entry - direct MCP is pinned, ready
    ]);
    await c.refreshApps();
    const ai = doc.querySelector("#applist .aiapp");
    expect(ai).not.toBeNull();
    expect(ai!.className).not.toContain("off"); // ready - no sign-in needed
    expect(ai!.textContent).toContain("AI chat");
  });

  it("shows the empty affordance (pointing at the Store) when no apps are installed", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [["/api/apps", { apps: [] }], ["/api/connectors/gateway", { status: [] }]]);
    await c.refreshApps();
    expect(doc.querySelectorAll("#applist .aitem")).toHaveLength(0); // no rows at all
    expect(doc.querySelector("#applist .appempty")!.textContent).toContain("Store");
  });

  it("ESCAPES an XSS-y app title — the payload is inert text, never a live element", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [["/api/apps", { apps: [{ repo: "team", name: "x", title: XSS, kind: "local" }] }], ["/api/connectors/gateway", { status: [] }]]);
    await c.refreshApps();
    expect(doc.querySelector("#applist img")).toBeNull();
    // [0] is the (only) app row carrying the payload - no Store row ahead of it anymore.
    expect(doc.querySelectorAll("#applist .albl")[0]!.textContent).toContain("<img");
  });
});

describe("console renderers (jsdom) — apps helpers + pane (appConn, rApps, buildAppPane)", () => {
  it("appConn resolves gateway status by app name, undefined when unrouted", () => {
    const { c } = loadConsole();
    c.S.gwStatus = { notion: { connected: true } };
    expect(c.appConn("notion").connected).toBe(true);
    expect(c.appConn("missing")).toBeUndefined();
  });

  it("rApps paints the legacy placeholder pointing at the Store", () => {
    const { doc, c } = loadConsole();
    c.rApps();
    expect(doc.querySelector("#rpanel h4")!.textContent).toBe("Apps");
    expect(doc.querySelector("#rpanel .rmini")!.textContent).toContain("Store");
  });

  it("buildAppPane renders an external app as an iframe, with a connect banner only when it needs auth", () => {
    const { c } = loadConsole();
    c.S.gwStatus = { proto: { needsAuth: true, authUrl: "https://auth.example.com" } };
    const pane = c.elt("div");
    c.buildAppPane({ id: "t1", pane, app: { repo: "team", name: "proto", title: "Proto", kind: "external", url: "https://app.example.com" } });
    expect(pane.querySelector("iframe")).not.toBeNull();
    expect(pane.querySelector(".connbanner")).not.toBeNull();
    expect(pane.querySelector("iframe").getAttribute("src")).toBe("https://app.example.com");

    // Same app, but connected (no needsAuth) → no banner.
    const pane2 = c.elt("div");
    c.S.gwStatus = { proto: { connected: true } };
    c.buildAppPane({ id: "t2", pane: pane2, app: { repo: "team", name: "proto", title: "Proto", kind: "external", url: "https://app.example.com" } });
    expect(pane2.querySelector(".connbanner")).toBeNull();
  });

  it("buildAppPane renders a local app in an opaque-origin sandbox (no allow-same-origin)", () => {
    const { c } = loadConsole();
    const pane = c.elt("div");
    c.buildAppPane({ id: "t3", pane, app: { repo: "team", name: "note", kind: "local", entry: "index.html" } });
    const ifr = pane.querySelector("iframe");
    expect(ifr.getAttribute("sandbox")).toContain("allow-scripts");
    expect(ifr.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(ifr.getAttribute("src")).toContain("/apps-serve/team/note/index.html");
  });

  it("ESCAPES an XSS-y external title in the connect banner (no live element)", () => {
    const { c } = loadConsole();
    c.S.gwStatus = { proto: { needsAuth: true } };
    const pane = c.elt("div");
    c.buildAppPane({ id: "t4", pane, app: { repo: "team", name: "proto", title: XSS, kind: "external", url: "https://app.example.com" } });
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.querySelector(".connbanner").textContent).toContain("<img");
  });

  it("has NO attribute breakout for a quote-breaking external URL (escAttr on the iframe src)", () => {
    const { c } = loadConsole();
    const pane = c.elt("div");
    const evilUrl = '"><img src=x onerror=alert(1)>';
    c.buildAppPane({ id: "t5", pane, app: { repo: "team", name: "proto", title: "Proto", kind: "external", url: evilUrl } });
    expect(pane.querySelector("img")).toBeNull();          // no injected element
    expect(pane.querySelectorAll("iframe")).toHaveLength(1); // the " didn't spawn a sibling / break the tag
    expect(pane.querySelector("iframe").getAttribute("src")).toBe(evilUrl); // survives as a literal attr value
  });
});

describe("console renderers (jsdom) — file/source connector editor (renderConnectorEditor)", () => {
  it("renders a connected connector with sync / view / disconnect controls", async () => {
    const { w, c } = loadConsole();
    routeFetch(w, [["/api/connectors", { connectors: [{ name: "gmail", description: "Gmail sync", auth: "oauth", cadence: "1h", connected: true, needsAuth: false }] }]]);
    const pane = c.elt("div");
    await c.renderConnectorEditor({ id: "t", pane }, "gmail");
    expect(pane.querySelector(".dh").textContent).toContain("gmail");
    expect(pane.querySelector(".pill.ok")).not.toBeNull();   // connected badge
    expect(pane.querySelector(".sync")).not.toBeNull();      // Sync now
    expect(pane.querySelector(".disc")).not.toBeNull();      // Disconnect
    expect(pane.querySelectorAll(".metarow").length).toBeGreaterThanOrEqual(3);
  });

  it("renders an OAuth-needs-auth connector with an Authorize affordance and warn badge", async () => {
    const { w, c } = loadConsole();
    routeFetch(w, [["/api/connectors", { connectors: [{ name: "slack", description: "", auth: "oauth", needsAuth: true, connected: false }] }]]);
    const pane = c.elt("div");
    await c.renderConnectorEditor({ id: "t", pane }, "slack");
    expect(pane.querySelector(".pill.warn")).not.toBeNull();
    expect(pane.querySelector(".auth")).not.toBeNull();
    expect(pane.querySelector(".auth").textContent).toContain("Slack"); // provider name capitalized
    expect(pane.querySelector(".sync")).toBeNull();                     // not connected → no sync yet
  });

  it("shows the 'unavailable' empty state for an unknown connector", async () => {
    const { w, c } = loadConsole();
    routeFetch(w, [["/api/connectors", { connectors: [] }]]);
    const pane = c.elt("div");
    await c.renderConnectorEditor({ id: "t", pane }, "ghost");
    expect(pane.querySelector(".empty")!.textContent).toContain("unavailable");
  });

  it("ESCAPES an XSS-y connector name in the header (no live element)", async () => {
    const { w, c } = loadConsole();
    routeFetch(w, [["/api/connectors", { connectors: [{ name: XSS, description: "d", auth: "oauth", needsAuth: true, connected: false }] }]]);
    const pane = c.elt("div");
    await c.renderConnectorEditor({ id: "t", pane }, XSS);
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.querySelector(".dh").textContent).toContain("<img");
  });
});

describe("console renderers (jsdom) — MCP gateway editor (renderMcpEditor)", () => {
  it("renders an existing server with its tool policy rows and edit controls", async () => {
    const { w, c } = loadConsole();
    routeFetch(w, [["/api/connectors/gateway", {
      status: [{ name: "linear", connected: true, url: "https://mcp.linear.app", scopes: ["read"] }],
      tools: [
        { name: "linear__create_issue", kind: "gated", baseline: "write", description: "Create an issue" },
        { name: "linear__search", kind: "read", baseline: "read", description: "Search issues" },
      ],
    }]]);
    const pane = c.elt("div");
    await c.renderMcpEditor({ id: "t", pane }, "linear");
    expect(pane.querySelector(".mcpedit")).not.toBeNull();
    expect(pane.querySelector(".f-name").getAttribute("value")).toBe("linear");
    expect(pane.querySelector(".f-url").getAttribute("value")).toBe("https://mcp.linear.app");
    expect(pane.querySelector(".save").textContent).toBe("Reconnect"); // editing existing
    expect(pane.querySelector(".rm")).not.toBeNull();                  // Remove present when editing
    expect(pane.querySelectorAll(".toolrow")).toHaveLength(2);
    expect(pane.querySelector(".tsh").textContent).toContain("Live tools (2)");
    expect(pane.querySelector(".toolrow .pill.warn")).not.toBeNull();  // gated tool badge
  });

  it("renders a blank 'Add MCP' editor when name is null (no Remove, Connect button)", async () => {
    const { w, c } = loadConsole();
    routeFetch(w, [["/api/connectors/gateway", { status: [], tools: [] }]]);
    const pane = c.elt("div");
    await c.renderMcpEditor({ id: "t", pane }, null);
    expect(pane.querySelector(".dh").textContent).toContain("Add an MCP connector");
    expect(pane.querySelector(".save").textContent).toBe("Connect");
    expect(pane.querySelector(".rm")).toBeNull();
    expect(pane.querySelectorAll(".toolrow")).toHaveLength(0);
  });

  it("ESCAPES an XSS-y tool name in its code label (no live element)", async () => {
    const { w, c } = loadConsole();
    routeFetch(w, [["/api/connectors/gateway", {
      status: [{ name: "srv", connected: true, url: "https://x" }],
      tools: [{ name: "srv__" + XSS, kind: "gated", baseline: "write", description: "d" }],
    }]]);
    const pane = c.elt("div");
    await c.renderMcpEditor({ id: "t", pane }, "srv");
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.querySelector(".toolrow code").textContent).toContain("<img");
  });

  it("ESCAPES an XSS-y server URL so it never forms an element in the value field", async () => {
    const { w, c } = loadConsole();
    routeFetch(w, [["/api/connectors/gateway", {
      status: [{ name: "srv", connected: false, needsAuth: false, url: XSS }],
      tools: [],
    }]]);
    const pane = c.elt("div");
    await c.renderMcpEditor({ id: "t", pane }, "srv");
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.querySelector(".f-url").getAttribute("value")).toContain("<img"); // inert, as text
  });
});
