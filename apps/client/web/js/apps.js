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

/**
 * Reload the installed apps and repaint the left rail: one row per app with its glyph, title, a live
 * connection badge (Connect / connected dot) from the gateway, and a hover "open interface" icon.
 * A row's DEFAULT click starts a new AI chat focused on that app (its MCP tools + skills); the 🌐 icon
 * opens the app's own interface in a tab. (The Store now lives in the section header, not a list row.)
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
  const host = $("#applist");
  host.innerHTML = "";
  if (!apps.length) {
    const empty = elt("div", "appempty");
    empty.innerHTML = 'No apps yet - open the <b>⊕ Store</b> above to add one.';
    host.appendChild(empty);
    return;
  }
  apps.forEach((a) => {
    const row = elt("div", "aitem");
    // short custom icon (≤3 chars) as-is, else a kind glyph: 🌐 external / ◈ local.
    const glyph = a.icon && a.icon.length <= 3 ? esc(a.icon) : (a.kind === "external" ? "🌐" : "◈");
    const c = appConn(a.name);
    const needsAuth = !!(c && c.needsAuth); // gateway-routed app whose tools aren't authorized yet
    // Two explicit actions per row (the row itself isn't clickable): the AI button starts an agent
    // chat to work WITH the app; the 🌐 button opens the app's own interface. The AI button doubles as
    // the connection indicator - "AI chat" when the tools are ready, "AI · not connected" otherwise
    // (it still opens the chat, where a discrete chip offers to connect).
    row.innerHTML = '<span class="aemoji">' + glyph + '</span><span class="albl">' + esc(a.title) + "</span>"
      + '<button class="aiapp' + (needsAuth ? " off" : "") + '" title="' + (needsAuth ? "Tools not connected - open a chat to connect and work with " : "Start an AI chat to work with ") + escAttr(a.title) + '">'
      + (needsAuth ? "AI · not connected" : "AI chat") + "</button>"
      + '<button class="aweb" title="Open ' + escAttr(a.title) + '’s interface">🌐</button>';
    // Not connected → open the Connect dialog first (never drop into a chat with dead tools).
    // Connected / no-auth-needed → straight into the AI chat.
    $(".aiapp", row).onclick = () => (needsAuth ? openConnectDialog(a) : openAppChat(a));
    $(".aweb", row).onclick = () => openAppTab(a);
    host.appendChild(row);
  });
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
 * Every click opens a fresh tab.
 * @param {object} app - the installed app record (name === catalog pack id).
 */
async function openAppChat(app) {
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
  if (S.activeProject) await postJSON("/api/projects/" + S.activeProject + "/items", { item: { type: "chat", sessionId: id, title: app.title } });
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
