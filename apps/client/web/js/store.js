"use strict";
// ⊕ Store pane, install/uninstall flow, inline approval.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
//
// Renders the left-rail "⊕ Store" (App Store) pane from /api/catalog, and drives the
// install/uninstall lifecycle: a ONE-TAP install (there is no scope to pick - the app face is the
// operator's, the pack's skills and policy are company rules; see brain/catalog.ts installPack), an
// inline approval overlay wired to the SAME server-side broker card the Pending tray uses
// (invariant #5), and a post-install offer to Connect any gateway-routed pack. State it reads on the shared global `S`: `S.tabs` (open
// tabs, to find/activate an existing Store tab).

/* ---------- left rail: ⊕ Store - App Store pane + install flow ---------- */

/** Open the single App Store tab, focusing it if one is already open, else building a fresh one. */
function openStoreTab() {
  const existing = S.tabs.find((t) => t.type === "store");
  if (existing) {
    activateTab(existing.id);
    return;
  }
  const tab = addTab({ type: "store", title: "App Store" });
  buildStorePane(tab);
}

/**
 * Mount the Store pane shell (heading + a "Loading…" grid placeholder) into `tab`, then fill it.
 * @param {object} tab - the tab whose `.pane` element hosts the Store UI.
 */
function buildStorePane(tab) {
  tab.pane.className = "pane storepane on";
  tab.pane.innerHTML = '<div class="storehd"><h2 class="storeh">App Store</h2>'
    + '<button class="mini ghost addcustom" title="Add your own external or local app">＋ Add a custom app</button></div>'
    + '<div class="storegrid">Loading…</div>';
  const add = $(".addcustom", tab.pane);
  if (add) add.onclick = () => openAddAppForm();
  loadStorePane(tab);
}

/**
 * Fetch the catalog and render one card per pack into the Store grid, wiring each card's
 * install/uninstall button.
 * @param {object} tab - the Store tab to (re)paint.
 */
async function loadStorePane(tab) {
  // `tab` may be null: the app-settings dialog drives the same install/uninstall/key verbs without a
  // Store tab open. Fall back to whichever Store tab IS open, so its cards still repaint.
  const t = tab || (S.tabs || []).find((x) => x.type === "store");
  const grid = t && t.pane ? $(".storegrid", t.pane) : null;
  if (!grid) return;
  let packs = [];
  try {
    packs = (await getJSON("/api/catalog")).packs || [];
  } catch (e) {
    grid.innerHTML = '<div class="storeerr">Store unavailable.</div>';
    return;
  }
  grid.innerHTML = "";
  if (!packs.length) {
    grid.innerHTML = '<div class="storeempty">No packs available.</div>';
    return;
  }
  const tabForActions = t;
  packs.forEach((p) => {
    const card = elt("div", "storecard");
    // Face badges: an "App" chip, a "Tools" (MCP) chip, and a "Skills ×N" chip, in that order,
    // dropping any face the pack doesn't expose.
    const badges = [p.faces && p.faces.app ? "App" : "", p.faces && p.faces.mcp ? "Tools" : "", p.faces && p.faces.apiKey ? "Key" : "", p.faces && p.faces.skills ? ("Skills ×" + p.faces.skills) : ""]
      .filter(Boolean).map((b) => '<span class="sbadge">' + esc(b) + '</span>').join("");
    // API-key affordance for an installed pack that declares an apiKey face: "Key ✓" (a key is stored -
    // tap to clear) or "Use API key" (paste one). For key-only packs (no mcp face) this is the ONLY
    // way to connect; for dual-door packs it sits alongside the OAuth Connect offer.
    const keyBtn = p.installed && p.faces && p.faces.apiKey
      ? (p.apiKeyConnected ? '<button class="mini ghost skeyclear">Key ✓</button>' : '<button class="mini skey">Use API key</button>')
      : "";
    const action = p.installed
      ? '<div class="srow"><span class="sinstalled">✓ Installed</span>' + keyBtn + '<button class="mini ghost scog" title="' + escAttr(p.name) + ' settings">⚙</button></div>'
      : '<button class="sinstall">Install</button>';
    card.innerHTML = '<div class="scardh"><span class="sicon">' + esc(p.icon || "◈") + '</span><span class="sname">' + esc(p.name) + '</span></div>'
      + '<div class="ssum">' + esc(p.summary || "") + '</div>'
      + '<div class="sbadges">' + badges + '</div>' + action;
    if (p.installed) {
      $(".scog", card).onclick = () => openAppSettings(p);
      if ($(".skey", card)) $(".skey", card).onclick = () => startApiKey(p, tabForActions);
      if ($(".skeyclear", card)) $(".skeyclear", card).onclick = () => clearApiKey(p, tabForActions);
    } else {
      $(".sinstall", card).onclick = () => startInstall(p, tabForActions);
    }
    mountAppLogo($(".sicon", card), p.id, "slogo"); // same progressive logo the rail uses
    grid.appendChild(card);
  });
}

/**
 * Prepend an inline notice (info or error) to the Store grid.
 * @param {object} tab  - the Store tab to notify in.
 * @param {string} msg  - the message text.
 * @param {string} kind - "info" for the neutral note style, anything else for the error style.
 */
function storeNotice(tab, msg, kind) {
  const t = tab || (S.tabs || []).find((x) => x.type === "store");
  const grid = t && t.pane ? $(".storegrid", t.pane) : null;
  if (!grid) return; // no Store open (the settings dialog path) - the rail refresh is the feedback
  grid.insertAdjacentHTML("afterbegin", '<div class="' + (kind === "info" ? "storenote" : "storeerr") + '">' + esc(msg) + '</div>');
}

/**
 * Run the install flow for `pack`: pick a target, fire the human-gated install, resolve it inline
 * via the approval overlay, then repaint the card and offer Connect for gateway-routed packs.
 * @param {object} pack - the catalog pack being installed.
 * @param {object} tab  - the Store tab driving the flow.
 */
async function startInstall(pack, tab) {
  // No scope question: installing is one tap. The app face is yours, the pack's skills and policy are
  // company rules that go to the team brain either way (see brain/catalog.ts installPack), and the
  // credential never leaves this machine's keychain - so there was never a real choice to offer.
  // Fire the install (blocks server-side on the broker decision) and DON'T await yet - the overlay
  // resolves the very card this POST creates, so the human-gate is honoured, just surfaced inline.
  const installP = postJSON("/api/catalog/install", { id: pack.id });
  const outcome = await confirmPending({ verb: "Install", name: pack.name, id: pack.id });
  if (outcome === "timeout") storeNotice(tab, "Approve “Install " + pack.name + "” in the Pending tray to finish.", "info");
  let res;
  try {
    res = await installP;
  } catch (e) {
    await loadStorePane(tab);
    storeNotice(tab, "Install failed - try again.");
    return;
  }
  if (res && res.error) {
    await loadStorePane(tab);
    storeNotice(tab, res.error === "install declined" ? "Install cancelled." : res.error, "info");
    return;
  }
  if (typeof refreshApps === "function") await refreshApps(); // installed app now in the rail
  await loadStorePane(tab); // card flips to Installed
  void offerConnect(pack); // if it routes through the gateway, offer to connect now
}

/* After installing a gateway-routed pack, poll the gateway until it registers the provider and
   surfaces an authorize URL, then offer a one-tap Connect. Direct-pinned packs never appear here, so
   the offer simply never fires for them. */

/**
 * Poll the gateway (up to 16 tries) for `pack`'s connector status; when it needs auth, show an
 * overlay offering a one-tap Connect. No-op if it's already connected or never surfaces an authUrl.
 * @param {object} pack - the just-installed pack to (maybe) offer Connect for.
 */
async function offerConnect(pack) {
  for (let i = 0; i < 16; i++) {
    let st;
    try {
      st = ((await getJSON("/api/connectors/gateway")).status || []).find((s) => s.name === pack.id);
    } catch (e) {}
    if (st && st.connected) return; // already authorized
    if (st && st.needsAuth && st.authUrl) {
      const bd = elt("div", "ovbackdrop");
      bd.innerHTML = '<div class="ovcard"><h3 class="ovh">Connect ' + esc(pack.name) + '?</h3>'
        + '<p class="ovp">' + esc(pack.name) + ' is installed. Authorize it so the agent can use its tools - you’ll sign in on ' + esc(pack.name) + '’s own page.</p>'
        + '<div class="ovrow"><button class="mini ovconnect">Connect ' + esc(pack.name) + '</button><button class="mini ghost ovlater">Later</button></div></div>';
      document.body.appendChild(bd);
      const close = () => bd.remove();
      bd.onclick = (e) => {
        if (e.target === bd) close();
      };
      $(".ovlater", bd).onclick = close;
      $(".ovconnect", bd).onclick = () => {
        connectApp({ name: pack.id, title: pack.name }, st);
        close();
      };
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Overlay to connect an installed pack with a pasted API key: a masked input, a link to where the
 * operator generates the key, and Save/Cancel. Save POSTs to /api/catalog/apikey (key → keychain,
 * never the repo), then repaints the store + apps rail. Mirrors offerConnect so the OAuth and key
 * paths feel the same. For key-only packs this is the only way to connect; for dual-door packs it
 * sits beside the OAuth Connect offer.
 * @param {object} pack - the installed pack being connected via key.
 * @param {object} tab - the store tab to repaint on success.
 */
async function startApiKey(pack, tab) {
  const ak = pack.apiKey || {};
  const bd = elt("div", "ovbackdrop");
  bd.innerHTML = '<div class="ovcard"><h3 class="ovh">Connect ' + esc(pack.name) + ' with an API key</h3>'
    + '<p class="ovp">Paste a key and the agent can use ' + esc(pack.name) + ' right away - no sign-in.'
    + (ak.docsUrl ? ' <a class="ovlink" href="' + escAttr(ak.docsUrl) + '" target="_blank" rel="noopener">Where do I find this?</a>' : '')
    + '</p><input class="ovinput skeyinput" type="password" autocomplete="off" spellcheck="false" placeholder="' + escAttr(ak.hint || "API key") + '" />'
    + '<div class="ovrow"><button class="mini ovsave">Save key</button><button class="mini ghost ovcancel">Cancel</button></div></div>';
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.onclick = (e) => { if (e.target === bd) close(); };
  $(".ovcancel", bd).onclick = close;
  const input = $(".skeyinput", bd);
  if (input) input.focus();
  $(".ovsave", bd).onclick = async () => {
    const key = input && input.value ? input.value.trim() : "";
    if (!key) { if (input) input.focus(); return; }
    try {
      await postJSON("/api/catalog/apikey", { id: pack.id, key: key });
    } catch (e) {
      close();
      storeNotice(tab, "Couldn’t save the key - try again.");
      return;
    }
    close();
    await loadStorePane(tab);
    if (typeof refreshApps === "function") await refreshApps();
  };
}

/**
 * Clear an installed pack's stored API key (POST an empty key): reverts a dual-door pack to OAuth and
 * disconnects a key-only pack. Repaints on success.
 * @param {object} pack - the pack whose key is being cleared.
 * @param {object} tab - the store tab to repaint.
 */
async function clearApiKey(pack, tab) {
  try {
    await postJSON("/api/catalog/apikey", { id: pack.id, key: "" });
  } catch (e) {
    storeNotice(tab, "Couldn’t clear the key - try again.");
    return;
  }
  await loadStorePane(tab);
  if (typeof refreshApps === "function") await refreshApps();
}

/**
 * Run the uninstall flow for `pack`: fire the human-gated uninstall against its installed scope,
 * resolve it inline via the approval overlay, then repaint the card.
 * @param {object} pack - the installed pack being removed.
 * @param {object} tab  - the Store tab driving the flow.
 */
async function startUninstall(pack, tab) {
  const target = pack.installedIn || "private"; // installs are per-operator now
  const uninstallP = postJSON("/api/catalog/uninstall", { id: pack.id, target });
  const outcome = await confirmPending({ verb: "Uninstall", name: pack.name, target, id: pack.id });
  if (outcome === "timeout") storeNotice(tab, "Approve “Uninstall " + pack.name + "” in the Pending tray to finish.", "info");
  let res;
  try {
    res = await uninstallP;
  } catch (e) {
    await loadStorePane(tab);
    storeNotice(tab, "Uninstall failed - try again.");
    return;
  }
  if (res && res.error) {
    await loadStorePane(tab);
    storeNotice(tab, res.error === "uninstall declined" ? "Uninstall cancelled." : res.error, "info");
    return;
  }
  if (typeof refreshApps === "function") await refreshApps(); // app leaves the rail
  await loadStorePane(tab); // card flips back to Install
}

/* Popup #2 - inline approval, wired to the SAME broker card the Pending tray uses (invariant #5).
   It never installs directly; it locates the pending card this action just created and resolves it
   via /api/approve, so it cannot bypass the server-side gate. If the operator dismisses it, the
   card stays in the tray as a fallback. Returns "approved" | "denied" | "timeout" | "dismiss". */

/**
 * Locate the pending broker card whose tool input matches this action's `id` (and `target`, when the
 * action carries one - install no longer does, since it has no scope to choose).
 * @param {object} match - {id, target?} identifying the just-created pending action.
 * @returns {Promise<object|null>} the matching card, or null if none is found / the fetch fails.
 */
function findPendingCard(match) {
  return getJSON("/api/pending")
    .then((d) => (d.cards || []).find((c) => c.tool && c.tool.input && c.tool.input.id === match.id
      && (match.target === undefined || c.tool.input.target === match.target)))
    .catch(() => null);
}

/**
 * Show the inline approval overlay for an install/uninstall and resolve the matching broker card.
 * @param {object} opts - {verb, name, id, target?} describing the pending action.
 * @returns {Promise<string>} "approved" | "denied" | "timeout" | "dismiss".
 */
function confirmPending(opts) { // {verb, name, id, target?}
  return new Promise((resolve) => {
    // Say what actually happens rather than asking again. An install adds the app for this operator
    // and files the pack's skills + rules in the team brain; an uninstall only affects one root.
    const what = opts.target === undefined
      ? "This adds <b>" + esc(opts.name) + "</b> to your apps, and files its skills and rules in the team brain for everyone."
      : "This is an outward change for <b>" + (opts.target === "team" ? "everyone on the team" : "just you") + "</b>.";
    const bd = elt("div", "ovbackdrop");
    bd.innerHTML = '<div class="ovcard"><h3 class="ovh">' + esc(opts.verb) + ' ' + esc(opts.name) + '?</h3>'
      + '<p class="ovp">' + what + ' Approve to continue.</p>'
      + '<div class="ovrow"><button class="mini ovapprove" disabled>Preparing…</button>'
      + '<button class="mini ghost ovlater">Not now</button></div></div>';
    document.body.appendChild(bd);
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      bd.remove();
      resolve(v);
    };
    (async () => {
      // Poll for the broker card this action just created (it lands asynchronously); give up after
      // ~2s and let the caller surface the Pending-tray fallback.
      let card = null, tries = 0;
      while (!card && tries < 20) {
        card = await findPendingCard(opts);
        if (card) break;
        tries++;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!card) {
        finish("timeout");
        return;
      }
      const btn = $(".ovapprove", bd);
      btn.disabled = false;
      btn.textContent = "Approve & " + opts.verb.toLowerCase();
      btn.onclick = async () => {
        btn.disabled = true;
        await resolveCard(card.id, "approve");
        finish("approved");
      };
      $(".ovlater", bd).onclick = async () => {
        await resolveCard(card.id, "deny");
        finish("denied");
      };
      bd.onclick = (e) => {
        if (e.target === bd) finish("dismiss");
      }; // dismiss → card left in tray as fallback
    })();
  });
}

/* Minimal inline overlay for target SELECTION only - never window.confirm/alert/prompt, which are
   real blocking dialogs and break the Electron/extension bridge. The install itself is human-gated
   server-side via the approval broker (Pending tray), so no loopback caller can install unattended. */

