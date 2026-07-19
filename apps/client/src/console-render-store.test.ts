// Browser test net for the App Store pane (store.js). Loads the real bundle into jsdom (via the
// shared console-harness), routes /api/catalog to controlled data, and asserts the rendered cards -
// in particular the API-key connection affordance added by the App-store-cleanup work: a "Use API
// key" action for an installed apiKey pack, "Key ✓" once a key is stored, and the "Key" face badge.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routeFetch(w: any, routes: Array<[string, unknown]>): void {
  w.fetch = (url: string) => {
    for (const [pat, data] of routes) {
      if (String(url).includes(pat)) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    }
    return Promise.reject(new Error("no route: " + url));
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function storeTab(doc: any) {
  const pane = doc.createElement("div");
  pane.innerHTML = '<div class="storegrid"></div>';
  return { pane };
}

describe("console store renderer (jsdom) - App Store cards", () => {
  it("an installed apiKey pack renders a 'Use API key' action + a 'Key' badge (emoji stays as the icon)", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [["/api/catalog", { packs: [
      { id: "hubspot", name: "HubSpot", icon: "🧲", summary: "CRM", installed: true, installedIn: "team",
        faces: { app: true, mcp: false, apiKey: true, skills: 2 }, apiKey: { transport: "rest", docsUrl: "https://x.co" } },
    ] }]]);
    const tab = storeTab(doc);
    await c.loadStorePane(tab);
    const card = tab.pane.querySelector(".storecard");
    expect(card.querySelector(".skey"), "paste-a-key action").toBeTruthy();
    expect(card.querySelector(".skeyclear"), "not connected yet").toBeNull();
    expect([...card.querySelectorAll(".sbadge")].map((b: { textContent: string | null }) => b.textContent)).toContain("Key");
    // jsdom never fires <img> onload, so the emoji is what a renderer test sees (logo is enhancement).
    expect(card.querySelector(".sicon").textContent).toBe("🧲");
  });

  it("shows 'Key ✓' (clear) instead of 'Use API key' when a key is already stored", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [["/api/catalog", { packs: [
      { id: "stripe", name: "Stripe", icon: "💳", summary: "Payments", installed: true, installedIn: "team",
        faces: { app: true, mcp: true, apiKey: true, skills: 2 }, apiKey: { transport: "mcp-bearer", docsUrl: "https://x.co" }, apiKeyConnected: true },
    ] }]]);
    const tab = storeTab(doc);
    await c.loadStorePane(tab);
    const card = tab.pane.querySelector(".storecard");
    expect(card.querySelector(".skeyclear")).toBeTruthy();
    expect(card.querySelector(".skey")).toBeNull();
  });

  it("an uninstalled apiKey pack shows Install and no key action (connect comes after install)", async () => {
    const { doc, w, c } = loadConsole();
    routeFetch(w, [["/api/catalog", { packs: [
      { id: "slack", name: "Slack", icon: "💬", summary: "Chat", installed: false,
        faces: { app: true, mcp: false, apiKey: true, skills: 2 }, apiKey: { transport: "rest", docsUrl: "https://x.co" } },
    ] }]]);
    const tab = storeTab(doc);
    await c.loadStorePane(tab);
    const card = tab.pane.querySelector(".storecard");
    expect(card.querySelector(".sinstall")).toBeTruthy();
    expect(card.querySelector(".skey")).toBeNull();
  });
});
