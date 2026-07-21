"use strict";
// Left rail apps list + external app panes + the app-driver bridge/host.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
//
// Renders the installed apps in the left rail (with live connection badges), opens each app as a
// tab (external apps in a webview/iframe, local apps in a sandboxed iframe fed the buildex bridge),
// and hosts the app-driver: a single page-session loop that lets the agent drive open app frames.
// State it reads/writes on the shared global `S`: `S.apps` (installed apps), `S.gwStatus`
// (connector-gateway status keyed by app name), `S.tabs` (open tabs), `S.active` (focused tab id),
// `S.config` (roots for the add-app form).

/* ---------- left: apps ---------- */

/** How many apps the rail shows before "Show N more". Enough to be a real menu, short enough that
 *  Sessions (directly below) is still on screen without scrolling. */
const APPS_VISIBLE = 5;

/** localStorage key for the operator's manual app order, scoped to the company so switching orgs
 *  doesn't inherit another company's ordering. Order is a pure UI preference (like panel collapse),
 *  so it lives on the machine, not in the repo - nothing about it belongs in company history. */
function appOrderKey() {
  const co = (S.config && S.config.company && (S.config.company.id || S.config.company.name)) || "default";
  return "buildex.appOrder:" + co;
}

/** The saved order as an array of app names (oldest-first), or [] when nothing was ever reordered. */
function savedAppOrder() {
  try {
    const v = JSON.parse(localStorage.getItem(appOrderKey()) || "[]");
    return Array.isArray(v) ? v.filter((n) => typeof n === "string") : [];
  } catch (e) {
    return [];
  }
}

/** Persist a new order (array of app names) and repaint the rail. */
function saveAppOrder(names) {
  try { localStorage.setItem(appOrderKey(), JSON.stringify(names)); } catch (e) {}
}

/**
 * Apply the operator's manual order to the server's list. Apps they have ranked come first in their
 * chosen order; anything new (installed since the last reorder) keeps the server's alphabetical order
 * and lands at the end, where it is noticeable rather than silently buried mid-list.
 * @param {Array} apps - the apps as returned by /api/apps (already alphabetical by title).
 * @returns {Array} the same apps, reordered.
 */
function orderApps(apps) {
  const order = savedAppOrder();
  if (!order.length) return apps.slice();
  const rank = new Map(order.map((n, i) => [n, i]));
  const ranked = apps.filter((a) => rank.has(a.name)).sort((a, b) => rank.get(a.name) - rank.get(b.name));
  return ranked.concat(apps.filter((a) => !rank.has(a.name)));
}

/**
 * Reload the installed apps and repaint the "Apps & Tools" rail: one row per app with its glyph,
 * title, a live connection badge from the gateway, and a 🌐 button for the app's own interface.
 * Clicking the ROW opens an AI chat focused on that app (the main use case - BuildEx is an
 * integrator + chat); a row whose tools aren't authorized opens the Connect dialog instead.
 * The list is capped at APPS_VISIBLE with a "Show N more" toggle, and "Edit" (section header) turns
 * it into a drag-to-reorder list. Both the expansion and the order are remembered locally.
 */
async function refreshApps() {
  let apps;
  try {
    apps = (await getJSON("/api/apps")).apps;
  } catch (e) {
    return;
  }
  S.apps = apps;
  // Real connection status from the connector gateway: providers keyed by name (= pack id).
  try {
    S.gwStatus = ((await getJSON("/api/connectors/gateway")).status || []).reduce((m, s) => {
      m[s.name] = s;
      return m;
    }, {});
  } catch (e) {
    /* gateway off → no badges */
  }
  renderApps();
  // An OAuth that finished in the browser lands here on the next poll: let any open app chat drop
  // its "not connected" gate the moment its tools are live, without the operator reloading.
  if (typeof syncAppConn === "function") (S.tabs || []).forEach(syncAppConn);
}

/** Paint the rail from S.apps + S.gwStatus (no fetching) — called by refreshApps and by every local
 *  interaction (expand, edit, reorder) that changes only how the list is shown. */
function renderApps() {
  const host = $("#applist");
  if (!host) return;
  const apps = orderApps(S.apps || []);
  const editing = !!S.appsEditing;
  host.innerHTML = "";
  host.className = "applist" + (editing ? " editing" : "");
  const editBtn = $("#appsEdit");
  if (editBtn) {
    editBtn.classList.toggle("on", editing);
    editBtn.textContent = editing ? "Done" : "Edit";
    editBtn.hidden = apps.length < 2; // nothing to reorder with 0 or 1 app
  }
  if (!apps.length) {
    const empty = elt("div", "appempty");
    empty.innerHTML = "No apps yet - open the <b>⊕ Store</b> above to add one.";
    host.appendChild(empty);
    return;
  }
  // While editing, show every app: you cannot drag something into a hidden part of the list.
  const shown = editing || S.appsExpanded ? apps : apps.slice(0, APPS_VISIBLE);
  shown.forEach((a) => host.appendChild(appRow(a, editing)));
  if (editing) {
    const note = elt("div", "editnote");
    note.textContent = "Drag to reorder. Your order is remembered on this machine.";
    host.appendChild(note);
    wireAppDrag(host, apps);
    return;
  }
  const hidden = apps.length - shown.length;
  if (hidden > 0 || S.appsExpanded) {
    const more = elt("button", "appmore");
    more.textContent = S.appsExpanded ? "Show less ▴" : "Show " + hidden + " more ▾";
    more.onclick = () => {
      S.appsExpanded = !S.appsExpanded;
      try { localStorage.setItem("buildex.appsExpanded", S.appsExpanded ? "1" : "0"); } catch (e) {}
      renderApps();
    };
    host.appendChild(more);
  }
}

/** An app's text glyph: its own short icon (≤3 chars) as-is, else a kind glyph (🌐 external / ◈ local).
 *  Returns ESCAPED text, safe to drop into innerHTML. The one definition - the rail, the start screen
 *  and the settings dialog all read from here. */
function appGlyph(a) {
  return a && a.icon && a.icon.length <= 3 ? esc(a.icon) : (a && a.kind === "external" ? "🌐" : "◈");
}

/**
 * Progressively upgrade a glyph to the pack's real logo, exactly as the Store card does - so an app
 * looks the same wherever it appears. The emoji stays if there is no logo for that id (custom apps,
 * packs without a mark) and in jsdom, which never fires onload; the image is pure enhancement.
 * @param {Element} host - the element holding the glyph; replaced by the <img> on load.
 * @param {string} id - the app/pack id (logos are served at /logos/<id>.png).
 * @param {string} [cls] - the class for the <img> (sizing differs per surface).
 */
function mountAppLogo(host, id, cls) {
  if (!host || typeof Image === "undefined") return;
  const img = new Image();
  img.className = cls || "alogo";
  img.alt = "";
  img.onload = () => { host.textContent = ""; host.appendChild(img); };
  img.src = "/logos/" + encodeURIComponent(id) + ".png";
}

/** One rail row. In edit mode it carries a drag handle and a settings button and no chat action
 *  (dragging a row must not also open a chat); otherwise the row itself opens the app's AI chat. */
function appRow(a, editing) {
  const row = elt("div", "aitem");
  row.dataset.app = a.name;
  const glyph = appGlyph(a);
  const c = appConn(a.name);
  const needsAuth = !!(c && c.needsAuth); // gateway-routed app whose tools aren't authorized yet
  if (editing) {
    row.draggable = true;
    row.innerHTML = '<span class="adrag" aria-hidden="true">⠿</span><span class="aemoji">' + glyph + '</span>'
      + '<span class="albl">' + esc(a.title) + "</span>"
      + '<button class="acog" title="' + escAttr(a.title) + ' settings">⚙</button>';
    mountAppLogo($(".aemoji", row), a.name);
    $(".acog", row).onclick = (e) => { e.stopPropagation(); openAppSettings(a); };
    return row;
  }
  row.title = "Start an AI chat to work with " + a.title;
  row.innerHTML = '<span class="aemoji">' + glyph + '</span><span class="albl">' + esc(a.title) + "</span>"
    + (needsAuth ? '<button class="aconn" title="' + escAttr(a.title) + ' isn’t connected - the agent can’t use its tools yet">not connected</button>' : "")
    + '<button class="aweb" title="Open ' + escAttr(a.title) + '’s interface">🌐</button>';
  mountAppLogo($(".aemoji", row), a.name);
  // The row IS the AI chat. Not connected → the Connect dialog first (never drop the operator into a
  // chat with dead tools); connected / no-auth-needed → straight into the chat.
  row.onclick = () => (needsAuth ? openConnectDialog(a) : openAppChat(a));
  const conn = $(".aconn", row);
  if (conn) conn.onclick = (e) => { e.stopPropagation(); openConnectDialog(a); };
  $(".aweb", row).onclick = (e) => { e.stopPropagation(); openAppTab(a); };
  return row;
}

/**
 * Wire HTML5 drag-and-drop over the rail's rows: dropping a row above/below another commits the new
 * order to localStorage and repaints. Reads the order from the DOM at drop time, so it stays correct
 * however many drags happened first.
 * @param {Element} host - the #applist element (its .aitem children are the draggable rows).
 * @param {Array} apps - the currently ordered apps (used to seed names not present in the DOM).
 */
function wireAppDrag(host, apps) {
  let dragged = null;
  const rows = () => [...host.querySelectorAll(".aitem")];
  rows().forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      dragged = row;
      row.classList.add("dragging");
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", row.dataset.app); } catch (err) {} }
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      rows().forEach((r) => r.classList.remove("over"));
      dragged = null;
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragged || row === dragged) return;
      rows().forEach((r) => r.classList.remove("over"));
      row.classList.add("over");
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!dragged || row === dragged) return;
      // Drop ABOVE the row when the cursor is in its top half, BELOW it otherwise.
      const box = row.getBoundingClientRect();
      const before = e.clientY < box.top + box.height / 2;
      host.insertBefore(dragged, before ? row : row.nextSibling);
      const names = rows().map((r) => r.dataset.app).filter(Boolean);
      // Anything not on screen (shouldn't happen in edit mode, but be safe) keeps its relative place.
      apps.forEach((a) => { if (!names.includes(a.name)) names.push(a.name); });
      saveAppOrder(names);
      renderApps();
    });
  });
}

/** Flip the rail between normal and drag-to-reorder mode (the "Edit"/"Done" button in the header). */
function toggleAppsEdit() {
  S.appsEditing = !S.appsEditing;
  renderApps();
}

/** The App Store catalog, cached after first fetch (used to look up an app's MCP + skills to orient a
 *  chat). Returns [] if the store is unavailable. */
async function appCatalog() {
  if (S.catalog) return S.catalog;
  try {
    S.catalog = (await getJSON("/api/catalog")).packs || [];
  } catch (e) {
    S.catalog = [];
  }
  return S.catalog;
}

/**
 * The AI action for an app row: open a NEW chat tab to work with `app` through the agent. The composer
 * stays EMPTY - the orienting context (the app's MCP tools + bundled skills) is INJECTED invisibly as a
 * system-prompt append on every turn (`tab.systemAppend`), not typed into the box. A discrete context
 * chip above the composer shows it's active and, if the tools aren't connected yet, offers to connect.
 * One chat per app: clicking the rail row again re-focuses the chat that is already open rather than
 * stacking up empty duplicates (the rail is now primary navigation, so it gets clicked a lot).
 * @param {object} app - the installed app record (name === catalog pack id).
 */
async function openAppChat(app) {
  const open = (S.tabs || []).find((t) => t.type === "chat" && t.app && t.app.name === app.name);
  if (open) {
    activateTab(open.id);
    return;
  }
  // Look up the app's catalog pack (id === app.name) for its MCP + skills, so the agent is oriented.
  const pack = (await appCatalog()).find((p) => p.id === app.name);
  const skills = (pack && pack.skills) || [];
  const hasMcp = !!(pack && pack.mcp) || (pack && pack.faces && pack.faces.mcp);
  // The invisible orienting append (system-prompt scope, never shown as a user message).
  const bits = ["The operator is working with the " + app.title + " app."];
  if (hasMcp) bits.push("Use its connector tools (" + app.name + ") to read and, with approval, act.");
  if (skills.length) bits.push("Its skills are available: " + skills.join(", ") + ".");
  if (app.kind === "external" && app.url) bits.push("Its web interface is at " + app.url + ".");
  const systemAppend = bits.join(" ");
  const conn = appConn(app.name);

  const proj = S.projects && S.projects.find((p) => p.id === S.activeProject);
  const folder = (proj && proj.name) || (S.config.company && S.config.company.name) || "Conversations";
  const { id } = await postJSON("/api/sessions", { folder, title: app.title });
  // `app` is persisted on the item so the rail can badge this chat with the app's mark, and so
  // re-opening the session restores the chat's app context (connect banner + logo) instead of
  // degrading it to a plain chat.
  if (S.activeProject) await postJSON("/api/projects/" + S.activeProject + "/items", { item: { type: "chat", sessionId: id, title: app.title, app: app.name } });
  await refreshProjects();
  const tab = addTab({ type: "chat", title: app.title, sessionId: id, status: "idle", systemAppend, app: app, appConn: conn });
  buildChatPane(tab);
  loadSession(tab);
}

/** Real gateway status for an app by name (= pack id), or undefined for direct-pinned/unrouted apps. */
function appConn(name) {
  return (S.gwStatus || {})[name];
}

/** Open the provider's authorize URL - the agent's runtime never renders this; the gateway (which
 *  owns the OAuth) produced it. Electron routes external URLs to the OS browser; the daemon's
 *  /oauth/<name>/callback finishes the exchange and the status flips to connected on the next poll. */
function connectApp(app, conn) {
  const url = conn && conn.authUrl;
  if (!url) return; // still registering with the gateway - the badge stays until authUrl lands
  window.open(url, "_blank"); // setWindowOpenHandler → shell.openExternal in the desktop app
}

/**
 * The ways this app can be connected for the agent, in preference order. Today apps declare an MCP
 * face (sign-in / OAuth); a pack MAY also declare an `api` face (an API-key alternative). The Connect
 * dialog shows a picker when there's more than one, and goes straight via the single route otherwise.
 * @returns {Array<{key:string,label:string,desc:string,run:Function}>}
 */
function appConnectRoutes(app, pack, conn) {
  const routes = [];
  if ((pack && pack.mcp) || (conn && conn.needsAuth)) {
    routes.push({
      key: "mcp",
      label: "Connect with sign-in",
      desc: "Authorize " + app.title + " on its own page so the agent can use its tools directly.",
      run: () => connectApp(app, conn || appConn(app.name)),
    });
  }
  if (pack && pack.api) {
    // Present only when a pack declares an API face; the picker then lets the operator choose it.
    routes.push({
      key: "api",
      label: "Use an API key",
      desc: "Connect " + app.title + " with an API key instead of signing in.",
      run: () => connectAppApi(app, pack.api),
    });
  }
  return routes;
}

/**
 * Ask how to connect an app before doing anything else - never drop the operator into a chat whose
 * tools are dead. One route → a simple confirm; two+ (MCP and API) → a picker. Cancelling leaves the
 * app unconnected. On MCP connect the OAuth page opens (external); the row flips to "AI chat" on the
 * next status poll.
 * @param {object} app - the app row that was clicked while "not connected".
 */
async function openConnectDialog(app) {
  const conn = appConn(app.name);
  const pack = (await appCatalog()).find((p) => p.id === app.name);
  const routes = appConnectRoutes(app, pack, conn);
  if (!routes.length) { openAppChat(app); return; } // nothing to connect → just open the chat

  const single = routes.length === 1;
  const bd = elt("div", "ovbackdrop");
  const btns = routes.map((r, i) => '<button class="mini' + (i > 0 ? " ghost" : "") + ' cxroute" data-i="' + i + '">' + esc(r.label) + "</button>").join("");
  bd.innerHTML = '<div class="ovcard"><h3 class="ovh">Connect ' + esc(app.title) + "</h3>"
    + '<p class="ovp">' + esc(single ? routes[0].desc : "Choose how to connect " + app.title + " so the agent can work with it:") + "</p>"
    + (single ? "" : '<ul class="ovlines">' + routes.map((r) => "<li><b>" + esc(r.label) + "</b> — " + esc(r.desc) + "</li>").join("") + "</ul>")
    + '<div class="ovrow">' + btns + '<button class="mini ghost cxcancel">Cancel</button></div></div>';
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.onclick = (e) => { if (e.target === bd) close(); };
  $(".cxcancel", bd).onclick = close;
  bd.querySelectorAll(".cxroute").forEach((b) => (b.onclick = () => { routes[+b.dataset.i].run(); close(); }));
}

/** API-key connection route (shown only when a pack declares an `api` face). The backing store isn't
 *  wired yet, so surface a clear note rather than a dead form - keeps the picker honest. */
function connectAppApi(app, api) {
  const bd = elt("div", "ovbackdrop");
  bd.innerHTML = '<div class="ovcard"><h3 class="ovh">API key — ' + esc(app.title) + "</h3>"
    + '<p class="ovp">API-key connection isn’t available yet' + (api && api.docs ? " (see the app’s API docs)" : "") + '. For now, use <b>Connect with sign-in</b>.</p>'
    + '<div class="ovrow"><button class="mini ovok">OK</button></div></div>';
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.onclick = (e) => { if (e.target === bd) close(); };
  $(".ovok", bd).onclick = close;
}

/**
 * Open (or re-focus) a tab for `app`, build its pane, and (unless joining is suppressed) record it
 * in the active project.
 * @param {object} app - the app record (repo/name/title/kind/url/entry).
 * @param {boolean} join - pass false to skip adding the app to the active project.
 */
function openAppTab(app, join) {
  const existing = S.tabs.find((t) => t.type === "app" && t.app && t.app.repo === app.repo && t.app.name === app.name);
  if (existing) {
    activateTab(existing.id);
    return;
  }
  const tab = addTab({ type: "app", title: app.title || app.name, app: app });
  buildAppPane(tab);
  if (join !== false) addToActiveProject({ type: "app", repo: app.repo, name: app.name });
}

/**
 * Fill an app tab's pane. External apps render in a webview (Electron) or sandboxed iframe (browser)
 * with an optional "not connected" banner; local apps render in an opaque-origin sandboxed iframe
 * served with the injected buildex bridge and get the parent-side app bridge wired up.
 */
function buildAppPane(tab) {
  tab.pane.className = "pane appane on";
  const app = tab.app,
    isE = /Electron/i.test(navigator.userAgent);
  if (app.kind === "external") {
    let url = app.url || "about:blank";
    const c = appConn(app.name);
    const banner = c && c.needsAuth
      ? '<div class="connbanner"><span class="cbtxt">🔌 <b>' + esc(app.title) + '</b> isn’t connected yet - the agent can’t use its tools until you authorize.</span><button class="mini connbtn">Connect</button></div>'
      : "";
    // Desktop: a <webview> on the isolated `persist:external-apps` partition (main.cjs locks its
    // session down - no hardware/location permissions, popups routed to the real browser, no local
    // schemes). Browser fallback: an <iframe> with an explicit sandbox allowlist.
    const view = isE
      ? '<webview src="' + escAttr(url) + '" partition="persist:external-apps" allowpopups></webview>'
      : '<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" src="' + escAttr(url) + '"></iframe>';
    tab.pane.innerHTML = banner + view;
    if (c && c.needsAuth) {
      const b = $(".connbtn", tab.pane);
      if (b) b.onclick = () => connectApp(app, c);
    }
    return;
  }
  // local app: opaque-origin sandbox (no allow-same-origin), served with the injected buildex bridge
  const src = "/apps-serve/" + encodeURIComponent(app.repo) + "/" + encodeURIComponent(app.name) + "/" + (app.entry || "index.html");
  tab.pane.innerHTML = '<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups" src="' + escAttr(src) + '"></iframe>';
  tab.frame = $("iframe", tab.pane);
  wireAppBridge(tab); // §Task 5 - parent side of window.buildex + agent DOM-driving
}

/**
 * Wire the parent side of a local app's iframe: (a) broker the app's data requests through
 * /apps-api/data, and (b) expose a per-tab `runCmd` so the global app-driver host can drive this
 * frame's DOM. Registers a `tab.dispose` that removes both message listeners on tab close.
 */
function wireAppBridge(tab) {
  const frame = tab.frame;
  if (!frame) return;
  // (a) data requests from the sandboxed app → broker via /apps-api/data
  const onMsg = async (e) => {
    if (e.source !== frame.contentWindow) return; // only this app's frame
    const d = e.data || {};
    if (!d.__buildexreq) return;
    let out = { __buildexres: true, id: d.id, ok: false };
    try {
      const r = await postJSON("/apps-api/data", { op: d.op, path: d.path, glob: d.glob });
      if (r.ok) {
        out.ok = true;
        out.result = r.result;
      } else out.error = r.error || "error";
    } catch (err) {
      out.error = String(err);
    }
    frame.contentWindow.postMessage(out, "*");
  };
  window.addEventListener("message", onMsg);
  // (b) per-tab command relay - runs agent DOM ops against THIS tab's frame. The single global
  // app-driver host (startAppHost, below) owns the subscribe/poll loop and routes by command.app;
  // this tab only exposes runCmd so the host can call into the right iframe.
  const pending = {}; // cmdId → resolve (agent DOM ops in flight)
  const onCmd = (e) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data || {};
    if (d.__appbridge && pending[d.cmdId]) {
      const p = pending[d.cmdId];
      delete pending[d.cmdId];
      p(d);
    }
  };
  window.addEventListener("message", onCmd);
  const runCmd = (cmd) =>
    new Promise((resolve) => {
      const cmdId = "c" + Math.random().toString(36).slice(2);
      pending[cmdId] = (res) => resolve(res.ok ? { ok: true, result: res.result } : { ok: false, error: res.error });
      frame.contentWindow.postMessage({ __appcmd: true, cmdId: cmdId, op: cmd.op, selector: cmd.selector, value: cmd.value }, "*");
      setTimeout(() => {
        if (pending[cmdId]) {
          delete pending[cmdId];
          resolve({ ok: false, error: "timeout" });
        }
      }, 7000);
    });
  tab.runCmd = runCmd;
  // tear down when the tab closes - just the two listeners; the global host stays subscribed.
  tab.dispose = () => {
    window.removeEventListener("message", onMsg);
    window.removeEventListener("message", onCmd);
  };
}

// Single global app-driver host: subscribes once for the page session and routes every drained
// command by command.app to the matching open tab's runCmd (or opens the app cold for "open").
let appHostStarted = false;

/**
 * Start the page-session app-driver loop (idempotent): subscribe once, then poll /api/app-frames and
 * dispatch each command to the matching open app tab (or open the app for an "open" command), posting
 * each result back to /api/app-result.
 */
async function startAppHost() {
  if (appHostStarted) return;
  appHostStarted = true;
  let token = null;
  try {
    token = (await postJSON("/api/app-subscribe", {})).token;
  } catch (e) {
    return;
  }
  while (true) {
    let frames = [];
    try {
      frames = (await getJSON("/api/app-frames")).frames || [];
    } catch (e) {}
    for (const fr of frames) {
      const c = fr.command || {};
      let res;
      if (c.op === "open") {
        const a = (S.apps || []).find((x) => x.name === c.app);
        if (a) {
          openAppTab(a);
          res = { ok: true };
        } else res = { ok: false, error: "unknown app: " + c.app };
      } else {
        const t = S.tabs.find((t) => t.type === "app" && t.app && t.app.name === c.app && t.frame && t.runCmd);
        res = t ? await t.runCmd(c) : { ok: false, error: "app not open: " + c.app };
      }
      try {
        await postJSON("/api/app-result", { id: fr.id, ok: res.ok, result: res.result, error: res.error });
      } catch (e) {}
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Render the "add app" dropdown form (kind/name/title/icon/url/repo), toggling the URL row for
 * external apps, and on submit POST /api/apps, refresh the rail, and open the newly created app.
 */
function openAddAppForm() {
  closeMenus();
  const repos = (S.config.roots || []).map((r) => r.name).filter((n) => n !== "core");
  const repoOpts = (repos.length ? repos : ["team", "private"]).map((n) => '<option value="' + escAttr(n) + '">' + esc(n) + "</option>").join("");
  const m = elt("div", "dropdown addapp");
  m.style.left = "10px";
  m.style.minWidth = "240px";
  m.dataset.menu = "1";
  m.innerHTML = '<div class="aform">'
    + '<label>Kind <select name="kind"><option value="external">External (web app URL)</option><option value="local">Local (sandboxed HTML)</option></select></label>'
    + '<label>Name <input name="name" placeholder="protocol" /></label>'
    + '<label>Title <input name="title" placeholder="Protocol" /></label>'
    + '<label>Icon <input name="icon" placeholder="🌐" maxlength="3" /></label>'
    + '<label class="urlrow">URL <input name="url" placeholder="https://app.protocolcrm.com" /></label>'
    + '<label>Repo <select name="repo">' + repoOpts + "</select></label>"
    + '<div class="arow"><button class="acancel">Cancel</button><button class="acreate">Add app</button></div>'
    + '<div class="aerr"></div></div>';
  $("#applist").parentElement.insertBefore(m, $("#applist"));
  const val = (n) => $('[name="' + n + '"]', m).value.trim();
  const kindSel = $('[name="kind"]', m),
    urlRow = $(".urlrow", m);
  const syncKind = () => {
    urlRow.style.display = kindSel.value === "external" ? "" : "none";
  };
  kindSel.onchange = syncKind;
  syncKind();
  $(".acancel", m).onclick = () => closeMenus();
  $(".acreate", m).onclick = async () => {
    const body = { repo: val("repo"), name: val("name"), kind: kindSel.value, title: val("title"), icon: val("icon"), url: val("url") };
    if (!body.name) {
      $(".aerr", m).textContent = "Name is required (kebab-case).";
      return;
    }
    const res = await postJSON("/api/apps", body);
    if (res.error) {
      $(".aerr", m).textContent = res.error;
      return;
    }
    closeMenus();
    await refreshApps();
    const created = (S.apps || []).find((a) => a.repo === body.repo && a.name === body.name);
    if (created) openAppTab(created);
  };
}
