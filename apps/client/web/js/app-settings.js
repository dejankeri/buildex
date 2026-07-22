"use strict";
// Per-app settings: one dialog that answers "what is this app doing for me, and can the agent
// actually reach it?" - connection state, the API-key alternative, where it lives, and removal.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via <script src>,
// sharing one global scope. NOT an ES module.
//
// It exists because those controls were scattered: connection lived on the rail badge, the API key on
// the Store card, uninstall on the Store card, and nothing showed WHY an app's tools were dead. One
// app, one place. Reached from the ⚙ on a rail row in Edit mode and the ⚙ on an installed Store card.
// Uses globals: S, $, el, elt, esc, escAttr, getJSON, postJSON, appConn, appCatalog, appGlyph,
// mountAppLogo, connectApp, refreshApps, startApiKey, clearApiKey, startUninstall, openAppTab.

/**
 * Open the settings dialog for an app or a catalog pack. Accepts either shape - the rail passes an
 * installed app record, the Store passes a pack - and resolves the other half itself, so both entry
 * points land on exactly the same dialog.
 * @param {object} appOrPack - an app record (has `.name`/`.title`) or a pack (has `.id`).
 */
async function openAppSettings(appOrPack) {
  const id = appOrPack.id || appOrPack.name;
  const pack = (await appCatalog()).find((p) => p.id === id);
  const app = (S.apps || []).find((a) => a.name === id);
  const title = (app && app.title) || (pack && pack.name) || id;

  const bd = elt("div", "ovbackdrop");
  bd.appendChild(elt("div", "ovcard appset"));
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.onclick = (e) => { if (e.target === bd) close(); };

  /** Repaint in place, so an action's result (connected, key saved) is visible without reopening. */
  const paint = () => {
    const card = $(".appset", bd);
    if (!card) return;
    card.innerHTML = "";
    card.append(...appSettingsBody({ id, title, app, pack, close, repaint: paint }));
  };
  paint();
}

/**
 * Build the dialog's body. Split out from the opener so it can be re-rendered in place and asserted
 * on directly in the renderer tests.
 * @returns {Array<Element>} the card's children.
 */
function appSettingsBody(ctx) {
  const { id, title, app, pack, close, repaint } = ctx;
  const conn = typeof appConn === "function" ? appConn(id) : undefined;
  const out = [];

  // --- header: the same mark and name the Store and the rail show -------------------------------
  const mark = el("span", { class: "as-ic", text: appGlyph(app || {}) });
  const head = el("div", { class: "as-hd" }, mark, el("h3", { class: "ovh", text: title }));
  mountAppLogo(mark, id, "as-logo");
  out.push(head);

  // --- connection: the question the operator actually has ---------------------------------------
  // Three real states, said plainly. "No tools" is NOT a problem to fix - a pack can be an app face
  // and nothing else - so it must not read like a broken connection.
  const hasTools = !!(conn || (pack && (pack.mcp || (pack.faces && pack.faces.mcp))));
  const state = !hasTools ? "none" : conn && conn.needsAuth ? "off" : "on";
  const line = {
    on: "Connected — the agent can use " + title + "’s tools.",
    off: "Not connected — the agent can’t read or act in " + title + " until you authorize it.",
    none: "This app has no tools for the agent. Open it in a tab to use it yourself.",
  }[state];
  const rows = [
    el("div", { class: "as-row as-" + state },
      el("span", { class: "as-dot" }),
      el("span", { class: "as-tx", text: line }),
      state === "off" && typeof connectApp === "function"
        ? el("button", { class: "mini as-connect", text: "Connect", onClick: () => { connectApp(app || { name: id, title }, conn); } })
        : null),
  ];
  if (state === "on" && conn && typeof conn.tools === "number") {
    rows.push(el("div", { class: "as-note", text: conn.tools + " tool" + (conn.tools === 1 ? "" : "s") + " available to the agent." }));
  }
  out.push(el("div", { class: "as-sec" }, el("h4", { class: "as-h", text: "Connection" }), ...rows));

  // --- API key: only for a pack that declares the alternative door ------------------------------
  if (pack && pack.faces && pack.faces.apiKey) {
    const keyed = !!pack.apiKeyConnected;
    out.push(el("div", { class: "as-sec" },
      el("h4", { class: "as-h", text: "API key" }),
      el("div", { class: "as-row" },
        el("span", { class: "as-tx", text: keyed ? "A key is stored on this machine, in your keychain." : "Connect with a key instead of signing in." }),
        keyed
          ? el("button", { class: "mini ghost as-keyclear", text: "Clear key", onClick: async () => { await clearApiKey(pack, null); repaint(); } })
          : el("button", { class: "mini as-key", text: "Use API key", onClick: () => { close(); startApiKey(pack, null); } })),
      el("div", { class: "as-note", text: "Keys never enter a repo — they stay in this machine’s keychain." })));
  }

  // --- where it lives ---------------------------------------------------------------------------
  const facts = [];
  if (app && app.url) facts.push(["Address", app.url]);
  if (app) facts.push(["Installed in", app.repo]);
  if (pack && pack.faces && pack.faces.skills) facts.push(["Team skills", pack.faces.skills + " shared with everyone"]);
  if (facts.length) {
    out.push(el("div", { class: "as-sec" }, el("h4", { class: "as-h", text: "Details" }),
      ...facts.map(([k, v]) => el("div", { class: "as-fact" }, el("span", { class: "as-k", text: k }), el("span", { class: "as-v", text: v })))));
  }

  // --- actions ----------------------------------------------------------------------------------
  const actions = [];
  if (app) actions.push(el("button", { class: "mini ghost as-open", text: "Open " + title, onClick: () => { close(); openAppTab(app); } }));
  if (pack && pack.installed) {
    actions.push(el("button", {
      class: "mini danger as-uninstall",
      text: "Uninstall",
      onClick: () => { close(); startUninstall(pack, null); },
    }));
  }
  actions.push(el("button", { class: "mini ghost as-done", text: "Done", onClick: close }));
  out.push(el("div", { class: "ovrow as-actions" }, ...actions));
  // A custom app (in the rail, not in the catalog) has no pack to uninstall - say so instead of
  // showing a button that would 404 on an unknown pack id.
  if (!pack) out.push(el("div", { class: "as-note", text: "This is your own app, not a Store pack — remove it by deleting its folder from the repo." }));
  return out;
}
