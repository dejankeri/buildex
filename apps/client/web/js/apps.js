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
 * Reload the installed apps and repaint the left rail: a Store row, then one row per app with its
 * glyph, title, repo, and a live connection badge (Connect / connected dot) from the gateway.
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
  const storeRow = elt("div", "aitem astore");
  storeRow.innerHTML = '<span class="aemoji">⊕</span><span class="albl">Store</span>';
  storeRow.onclick = () => openStoreTab();
  host.appendChild(storeRow);
  if (!apps.length) {
    host.insertAdjacentHTML("beforeend", '<div class="appempty">No apps yet - add one with ＋ above.</div>');
    return;
  }
  apps.forEach((a) => {
    const active = S.active && S.tabs.find((t) => t.id === S.active && t.type === "app" && t.app && t.app.repo === a.repo && t.app.name === a.name);
    const row = elt("div", "aitem" + (active ? " active" : ""));
    // short custom icon (≤3 chars) as-is, else a kind glyph: 🌐 external / ◈ local.
    const glyph = a.icon && a.icon.length <= 3 ? esc(a.icon) : (a.kind === "external" ? "🌐" : "◈");
    const c = appConn(a.name);
    const badge = c && c.needsAuth
      ? '<span class="aconn" title="Not connected - click to authorize">Connect</span>'
      : (c && c.connected ? '<span class="acdot" title="Connected - the agent can use its tools"></span>' : "");
    row.innerHTML = '<span class="aemoji">' + glyph + '</span><span class="albl">' + esc(a.title) + "</span>" + badge + '<span class="arepo">' + esc(a.repo) + "</span>";
    row.onclick = () => openAppTab(a);
    if (c && c.needsAuth) {
      const b = $(".aconn", row);
      if (b)
        b.onclick = (e) => {
          e.stopPropagation();
          connectApp(a, c);
        };
    }
    host.appendChild(row);
  });
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
