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

/** A rail render with `n` apps named app0..app(n-1), none of them gateway-routed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function railWith(n: number, c: any, w: any): Promise<void> {
  const apps = Array.from({ length: n }, (_, i) => ({ repo: "team", name: "app" + i, title: "App " + i, kind: "local" }));
  routeFetch(w, [["/api/apps", { apps }], ["/api/connectors/gateway", { status: [] }]]);
  await c.refreshApps();
}

describe("console renderers (jsdom) — apps left rail (refreshApps)", () => {
  it("paints one row per app (Store lives in the header now); the ROW opens the AI chat", async () => {
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
    // The row itself is the AI-chat action now (no per-row AI button), plus a 🌐 interface button.
    expect(doc.querySelectorAll("#applist .aiapp")).toHaveLength(0);
    expect(doc.querySelectorAll("#applist .aweb")).toHaveLength(2);
    expect(typeof (doc.querySelector("#applist .aitem") as any).onclick).toBe("function");
    // needsAuth app → a "not connected" badge; the connected app carries none.
    const badges = doc.querySelectorAll("#applist .aconn");
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toContain("not connected");
    expect(doc.querySelectorAll("#applist .albl")[0]!.textContent).toBe("Protocol");
  });

  it("an app whose tools need no gateway auth carries no 'not connected' badge", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [
      ["/api/apps", { apps: [{ repo: "team", name: "gmail", title: "Gmail", kind: "local" }] }],
      ["/api/connectors/gateway", { status: [] }], // no gateway entry - direct MCP is pinned, ready
    ]);
    await c.refreshApps();
    expect(doc.querySelector("#applist .aitem")).not.toBeNull();
    expect(doc.querySelector("#applist .aconn")).toBeNull(); // ready - no sign-in needed
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

describe("console renderers (jsdom) — apps rail: the visible cap and its expand toggle", () => {
  it("shows only the first 5 apps, with a 'Show 3 more' toggle that reveals the rest", async () => {
    const { doc, w, c } = loadConsole();
    await railWith(8, c, w);
    expect(doc.querySelectorAll("#applist .aitem")).toHaveLength(5);
    const more = doc.querySelector("#applist .appmore") as any;
    expect(more.textContent).toContain("Show 3 more");
    more.click();
    expect(doc.querySelectorAll("#applist .aitem")).toHaveLength(8);
    expect(doc.querySelector("#applist .appmore")!.textContent).toContain("Show less");
    // …and collapses again.
    (doc.querySelector("#applist .appmore") as any).click();
    expect(doc.querySelectorAll("#applist .aitem")).toHaveLength(5);
  });

  it("offers no toggle at all when everything already fits", async () => {
    const { doc, w, c } = loadConsole();
    await railWith(3, c, w);
    expect(doc.querySelectorAll("#applist .aitem")).toHaveLength(3);
    expect(doc.querySelector("#applist .appmore")).toBeNull();
  });
});

describe("console renderers (jsdom) — apps rail: manual order (orderApps + edit mode)", () => {
  it("orderApps puts saved names first in their saved order and appends anything new", () => {
    const { c, w } = loadConsole();
    const apps = [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "fresh" }];
    (w.localStorage as any).setItem(c.appOrderKey(), JSON.stringify(["c", "a", "b"]));
    // Newly installed apps are NOT silently buried mid-list — they land at the end, where they show.
    expect(c.orderApps(apps).map((a: { name: string }) => a.name)).toEqual(["c", "a", "b", "fresh"]);
  });

  it("orderApps is a no-op (server's alphabetical order survives) when nothing was reordered", () => {
    const { c } = loadConsole();
    const apps = [{ name: "a" }, { name: "b" }];
    expect(c.orderApps(apps).map((a: { name: string }) => a.name)).toEqual(["a", "b"]);
  });

  it("edit mode shows EVERY app with a drag handle and no actions, and Done restores the cap", async () => {
    const { doc, w, c } = loadConsole();
    await railWith(8, c, w);
    c.toggleAppsEdit();
    // All 8 — you cannot drag a row into a hidden part of the list.
    expect(doc.querySelectorAll("#applist .aitem")).toHaveLength(8);
    expect(doc.querySelectorAll("#applist .adrag")).toHaveLength(8);
    expect(doc.querySelector("#applist .aweb")).toBeNull();          // no actions while reordering
    expect((doc.querySelector("#applist .aitem") as any).draggable).toBe(true);
    expect(doc.querySelector("#appsEdit")!.textContent).toBe("Done");
    c.toggleAppsEdit();
    expect(doc.querySelectorAll("#applist .aitem")).toHaveLength(5);
    expect(doc.querySelector("#appsEdit")!.textContent).toBe("Edit");
  });

  it("hides Edit entirely when there is nothing to reorder", async () => {
    const { doc, w, c } = loadConsole();
    await railWith(1, c, w);
    expect((doc.querySelector("#appsEdit") as any).hidden).toBe(true);
    await railWith(2, c, w);
    expect((doc.querySelector("#appsEdit") as any).hidden).toBe(false);
  });
});

describe("console renderers (jsdom) — apps helpers + pane (appConn, buildAppPane)", () => {
  it("appConn resolves gateway status by app name, undefined when unrouted", () => {
    const { c } = loadConsole();
    c.S.gwStatus = { notion: { connected: true } };
    expect(c.appConn("notion").connected).toBe(true);
    expect(c.appConn("missing")).toBeUndefined();
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

describe("console renderers (jsdom) — per-app settings dialog (appSettingsBody)", () => {
  const APP = { repo: "private", name: "slack", title: "Slack", kind: "external", url: "https://slack.com", icon: "💬" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function body(c: any, over: Record<string, unknown> = {}) {
    const host = c.elt("div");
    host.append(...c.appSettingsBody({ id: "slack", title: "Slack", app: APP, pack: null, close: () => {}, repaint: () => {}, ...over }));
    return host;
  }

  it("says the tools are connected, and how many the agent can see", () => {
    const { c } = loadConsole();
    c.S.gwStatus = { slack: { name: "slack", connected: true, tools: 7 } };
    const h = body(c);
    expect(h.querySelector(".as-on")).not.toBeNull();
    expect(h.querySelector(".as-tx")!.textContent).toContain("Connected");
    expect(h.querySelector(".as-note")!.textContent).toContain("7 tools");
    expect(h.querySelector(".as-connect")).toBeNull(); // nothing to do
  });

  it("names the consequence, not the state, when the app isn't connected — and offers Connect", () => {
    const { c } = loadConsole();
    c.S.gwStatus = { slack: { name: "slack", needsAuth: true, authUrl: "https://auth.example.com" } };
    const h = body(c);
    expect(h.querySelector(".as-off")).not.toBeNull();
    expect(h.querySelector(".as-tx")!.textContent).toContain("can’t read or act in Slack");
    expect(h.querySelector(".as-connect")).not.toBeNull();
  });

  it("does NOT read as broken for an app that simply has no tools", () => {
    const { c } = loadConsole();
    c.S.gwStatus = {};
    const h = body(c, { pack: { id: "slack", name: "Slack", installed: true, faces: { app: true, mcp: false, apiKey: false, skills: 0 } } });
    expect(h.querySelector(".as-off")).toBeNull();
    expect(h.querySelector(".as-tx")!.textContent).toContain("no tools for the agent");
  });

  it("offers the API-key door only for a pack that declares one, and says where the key lives", () => {
    const { c } = loadConsole();
    c.S.gwStatus = {};
    const withKey = { id: "slack", name: "Slack", installed: true, faces: { app: true, mcp: true, apiKey: true, skills: 2 } };
    expect(body(c, { pack: withKey }).querySelector(".as-key")).not.toBeNull();
    expect(body(c, { pack: withKey }).querySelector(".as-note")!.textContent).toBeTruthy();
    // A stored key flips it to Clear.
    const keyed = body(c, { pack: { ...withKey, apiKeyConnected: true } });
    expect(keyed.querySelector(".as-keyclear")).not.toBeNull();
    expect(keyed.querySelector(".as-key")).toBeNull();
    // …and a pack without the face never shows the section at all.
    const noKey = body(c, { pack: { ...withKey, faces: { ...withKey.faces, apiKey: false } } });
    expect(noKey.querySelector(".as-key")).toBeNull();
    expect(noKey.querySelector(".as-keyclear")).toBeNull();
  });

  it("offers Uninstall for an installed pack, and explains its absence for a custom app", () => {
    const { c } = loadConsole();
    c.S.gwStatus = {};
    const installed = body(c, { pack: { id: "slack", name: "Slack", installed: true, faces: { app: true, mcp: true, apiKey: false, skills: 2 } } });
    expect(installed.querySelector(".as-uninstall")).not.toBeNull();
    // A hand-made app has no pack behind it — a button here would 404 on an unknown pack id.
    const custom = body(c); // pack: null
    expect(custom.querySelector(".as-uninstall")).toBeNull();
    expect(custom.textContent).toContain("your own app");
  });

  it("shows where the app lives, and what the install shared with the team", () => {
    const { c } = loadConsole();
    c.S.gwStatus = {};
    const h = body(c, { pack: { id: "slack", name: "Slack", installed: true, faces: { app: true, mcp: true, apiKey: false, skills: 2 } } });
    const facts = [...h.querySelectorAll(".as-fact")].map((f) => f.textContent);
    expect(facts.join(" ")).toContain("https://slack.com");
    expect(facts.join(" ")).toContain("private");
    expect(facts.join(" ")).toContain("2 shared with everyone");
  });

  it("ESCAPES an XSS-y app title (the dialog is built, not concatenated)", () => {
    const { c } = loadConsole();
    c.S.gwStatus = {};
    const h = body(c, { title: XSS, app: { ...APP, title: XSS } });
    expect(h.querySelector("img")).toBeNull();
    expect(h.querySelector(".ovh")!.textContent).toBe(XSS);
  });
});

describe("console renderers (jsdom) — the rail's ⚙ (Edit mode) and shared app glyph", () => {
  it("gives every row a settings button in Edit mode, and none outside it", async () => {
    const { doc, w, c } = loadConsole();
    await railWith(3, c, w);
    expect(doc.querySelector("#applist .acog")).toBeNull();
    c.toggleAppsEdit();
    expect(doc.querySelectorAll("#applist .acog")).toHaveLength(3);
  });

  it("appGlyph prefers the app's own short icon, else a kind glyph, and escapes it", () => {
    const { c } = loadConsole();
    expect(c.appGlyph({ icon: "💬", kind: "external" })).toBe("💬");
    expect(c.appGlyph({ kind: "external" })).toBe("🌐");
    expect(c.appGlyph({ kind: "local" })).toBe("◈");
    expect(c.appGlyph({ icon: "a-very-long-not-an-icon", kind: "local" })).toBe("◈");
    expect(c.appGlyph({ icon: "<b>", kind: "local" })).not.toContain("<b>"); // escaped, it lands in innerHTML
  });
});
