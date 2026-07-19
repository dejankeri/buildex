"use strict";
// MCP gateway + file/source connector editors.
//
// Renders the right-rail connector surfaces and their full-tab editors: the MCP gateway (a live
// list plus a per-tool policy editor) and the file/source connectors (Gmail/Slack/Notion…, which
// sync read-only into sources/<name>/). All markup is built as innerHTML strings; every dynamic
// value is passed through `esc()` before interpolation.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// State it reads on the shared global `S`: `S.tabs` (open tabs, to focus/dedupe editors),
// `S.config` (server config, for the team root), `S.rightTab` (the active right-rail tab, to
// decide whether to repaint the rail after a write).

// The OAuth+MCP gateway: the panel is a compact list; add/edit opens the full editor in the
// center tab. Reads pass through to the agent, writes/sends wait in Pending. Shown only when hosted.
/**
 * Render the MCP gateway card list into the right-rail `#gwl` container.
 * @returns {Promise<void>} resolves once the list is painted (or bails if the container/API is absent).
 */
async function rGateway() {
  const gwl = $("#gwl");
  if (!gwl) return;
  let gw;
  try {
    gw = await getJSON("/api/connectors/gateway");
  } catch (e) {
    return;
  }
  gwl.innerHTML = "";
  const tools = gw.tools || [],
    st = gw.status || [],
    gated = tools.filter((t) => t.kind === "gated").length;
  const head = elt("div", "rcard");
  head.innerHTML =
    '<div class="cn">⚡ MCP gateway <span class="pill ok">live</span> <button class="mini" id="mcpAdd" style="float:right;margin-top:-2px">+ Add MCP</button></div><div class="cd">' +
    tools.length +
    " agent tool" +
    (tools.length === 1 ? "" : "s") +
    (tools.length ? " (" + gated + " gated → Pending)" : " - add an MCP server to give the agent live, gated tools") +
    "</div>";
  gwl.appendChild(head);
  $("#mcpAdd").onclick = () => openMcpEditor(null);
  st.forEach((s) => {
    const c = elt("div", "rcard gwcard");
    const badge = s.connected ? '<span class="pill ok">connected</span>' : (s.needsAuth ? '<span class="pill">needs sign-in</span>' : '<span class="pill">off</span>');
    c.innerHTML =
      '<div class="cn">⚡ ' +
      esc(s.name) +
      " " +
      badge +
      ' <span class="mini ghost" style="float:right;margin-top:-2px">Details →</span></div><div class="cd">' +
      (s.connected ? (s.tools + " tool" + (s.tools === 1 ? "" : "s") + " live for the agent") : (s.needsAuth ? "authorize to finish connecting" : "not connected")) +
      "</div>";
    c.style.cursor = "pointer";
    c.onclick = () => openMcpEditor(s.name);
    gwl.appendChild(c);
  });
}

// Full MCP connector editor, opened in a center tab. name=null → new; name=string → edit existing.
/**
 * Open (or focus) the full MCP connector editor in a center tab.
 * @param {string|null} name - the MCP server name to edit, or null to open a blank "Add MCP" tab.
 * @returns {Promise<void>} resolves once the editor has been rendered into the tab.
 */
async function openMcpEditor(name) {
  const ex = S.tabs.find((t) => t.type === "mcp" && t.name === (name || ""));
  if (ex) {
    activateTab(ex.id);
    return;
  }
  const tab = addTab({ type: "mcp", title: name ? ("MCP: " + name) : "Add MCP", name: name || "" });
  tab.pane.className = "pane editorpane on";
  tab.pane.innerHTML = "loading…";
  await renderMcpEditor(tab, name);
}

/**
 * Build the MCP editor's markup (name/URL/scopes form + per-tool policy segments) and wire its
 * controls: the save/reconnect button, the remove button, and each tool's pass-through/gate/hide
 * segment.
 * @param {object} tab - the tab whose `.pane` the editor is rendered into.
 * @param {string|null} name - the MCP server being edited, or null/"" for a new connector.
 * @returns {Promise<void>} resolves once the editor is rendered and wired.
 */
async function renderMcpEditor(tab, name) {
  let gw = { status: [], tools: [] };
  try {
    gw = await getJSON("/api/connectors/gateway");
  } catch (e) {}
  const row = (gw.status || []).find((s) => s.name === name) || null;
  // Pull this server's tools out of the flat gateway list, strip the "<name>__" prefix off each,
  // and resolve the display baseline (a hidden tool falls back to "gated").
  const myTools = (gw.tools || [])
    .filter((t) => t.name.indexOf((name || "") + "__") === 0)
    .map((t) => ({ name: t.name.slice((name || "").length + 2), kind: t.kind, baseline: t.baseline || (t.kind === "hidden" ? "gated" : t.kind), description: t.description || "" }));
  const editing = !!name;
  const st = row ? (row.connected ? '<span class="pill ok">connected</span>' : (row.needsAuth ? '<span class="pill warn">needs sign-in</span>' : '<span class="pill">off</span>')) : "";
  let html =
    '<div class="editor mcpedit"><div class="dh">⚡ ' +
    (editing ? ("MCP: " + esc(name) + " " + st) : "Add an MCP connector") +
    "</div>" +
    '<p class="ehint">An MCP server gives your agent live tools. BuildEx proxies it: <b>read</b> tools pass straight through, <b>write/send</b> tools wait for your tap in the Pending tray.</p>' +
    '<label>Name<input class="f-name" placeholder="linear" value="' +
    esc(name || "") +
    '"' +
    (editing ? " disabled" : "") +
    "></label>" +
    '<label>MCP server URL<input class="f-url" placeholder="https://mcp.example.com/mcp" value="' +
    esc(row && row.url || "") +
    '"></label>' +
    '<label>Scopes <span class="sub2">(optional, space-separated)</span><input class="f-scopes" placeholder="read write" value="' +
    esc(row && row.scopes && row.scopes.join(" ") || "") +
    '"></label>' +
    '<div class="ebar"><button class="mini save">' +
    (editing ? "Reconnect" : "Connect") +
    "</button>" +
    (editing ? '<button class="mini ghost rm">Remove</button>' : "") +
    '<span class="emsg"></span></div>';
  if (row && row.needsAuth && row.authUrl) {
    // safeHref (not esc) for the URL: it both attribute-escapes AND blocks non-http(s) schemes, so a
    // tampered authUrl can't smuggle a javascript: link. If it isn't a safe URL, drop the link.
    const authHref = safeHref(row.authUrl);
    html += authHref
      ? '<div class="authbox">Sign-in required - <a href="' + authHref + '" target="_blank" rel="noopener">Authorize in your browser →</a>, then this connector goes live.</div>'
      : '<div class="authbox">Sign-in required - open your connector settings to authorize.</div>';
  }
  if (myTools.length) {
    html +=
      '<div class="toolsec"><div class="tsh">Live tools (' +
      myTools.length +
      ")</div>" +
      '<p class="ehint tighthint">Tighten access per tool: <b>gate</b> a tool so it waits for your tap, or <b>hide</b> it from the agent. An outward tool’s gate can only be added, never removed.</p>';
    // One three-way policy control (pass-through / gate / hide) per tool. The current kind is shown
    // "on" and disabled; a "read" segment locks when the tool's baseline isn't read (an outward
    // tool — its human gate can never be lifted).
    const seg = (t) => {
      const opt = (k, label) => {
        const on = t.kind === k,
          lock = (k === "read" && t.baseline !== "read");
        return '<button class="tseg' +
          (on ? " on" : "") +
          (lock ? " lock" : "") +
          '"' +
          ((on || lock) ? " disabled" : ' data-tool="' + escAttr(t.name) + '" data-kind="' + k + '"') +
          (lock ? ' title="Outward tool - the human gate can’t be removed"' : "") +
          ">" +
          label +
          "</button>";
      };
      return '<div class="tpol">' + opt("read", "pass-through") + opt("gated", "gate") + opt("hidden", "hide") + "</div>";
    };
    myTools.forEach((t) => {
      const pc = t.kind === "gated" ? "warn" : (t.kind === "hidden" ? "muted" : "ok");
      html +=
        '<div class="toolrow' +
        (t.kind === "hidden" ? " ishidden" : "") +
        '"><span class="pill ' +
        pc +
        '">' +
        t.kind +
        '</span> <code>' +
        esc(t.name) +
        "</code>" +
        seg(t) +
        '<div class="td">' +
        esc(t.description || "") +
        "</div></div>";
    });
    html += "</div>";
  } else if (editing && row && row.connected) html += '<div class="toolsec"><div class="tsh">No tools reported.</div></div>';
  html += "</div>";
  tab.pane.innerHTML = html;
  // Per-tool policy change: POST the new kind, then repaint the rail (if visible) and this editor.
  $$(".tseg[data-tool]", tab.pane).forEach(
    (b) =>
      b.onclick = async () => {
        const tool = b.dataset.tool,
          kind = b.dataset.kind,
          msg = $(".emsg", tab.pane);
        b.disabled = true;
        let r;
        try {
          r = await postJSON("/api/connectors/gateway/" + encodeURIComponent(name) + "/policy", { tool, kind });
        } catch (e) {
          if (msg) msg.innerHTML = '<span class="bad">request failed</span>';
          b.disabled = false;
          return;
        }
        if (r && r.error) {
          if (msg) msg.innerHTML = '<span class="bad">' + esc(r.error) + "</span>";
          b.disabled = false;
          return;
        }
        if (S.rightTab === "apps") rGateway();
        renderMcpEditor(tab, name);
      },
  );
  // Save/connect: validate name+URL, POST the connector, surface the auth/connected result, and
  // re-render after a short delay (shorter when an auth handoff is pending).
  $(".save", tab.pane).onclick = async () => {
    const nm = ($(".f-name", tab.pane).value || name || "").trim(),
      u = $(".f-url", tab.pane).value.trim(),
      sc = $(".f-scopes", tab.pane).value.trim();
    const msg = $(".emsg", tab.pane);
    if (!nm || !u) {
      msg.innerHTML = '<span class="bad">name and URL are required</span>';
      return;
    }
    msg.textContent = "Connecting…";
    let r;
    try {
      r = await postJSON("/api/connectors/gateway", { name: nm, url: u, scopes: sc ? sc.split(/\s+/) : [] });
    } catch (e) {
      msg.innerHTML = '<span class="bad">request failed</span>';
      return;
    }
    if (r && r.error) {
      msg.innerHTML = '<span class="bad">' + esc(r.error) + "</span>";
      return;
    }
    if (r && r.needsAuth) msg.innerHTML = '<span class="warn">Authorize to finish →</span>';
    else msg.innerHTML = '<span class="good">Connected ✓</span>';
    tab.name = nm;
    tab.title = "MCP: " + nm;
    renderTabbar();
    if (S.rightTab === "apps") rGateway();
    setTimeout(() => renderMcpEditor(tab, nm), r && r.needsAuth ? 400 : 900);
  };
  // Remove: drop the connector and close the tab.
  const rmb = $(".rm", tab.pane);
  if (rmb)
    rmb.onclick = async () => {
      rmb.disabled = true;
      rmb.textContent = "Removing…";
      try {
        await postJSON("/api/connectors/gateway/" + encodeURIComponent(name) + "/remove", {});
      } catch (e) {}
      if (S.rightTab === "apps") rGateway();
      closeTab(tab.id);
    };
}
// Legacy connector/gateway management UI hidden here (Task 7 - the App Store is now the one path
// to add Gmail/Slack/Notion/etc). rGateway/openConnectorEditor/openMcpEditor are left defined but
// unreached; /api/connectors* + the gateway backend are untouched.
/**
 * Render the (now legacy) right-rail Apps panel — a pointer to the left-rail Store.
 * @returns {Promise<void>} resolves once the placeholder panel is painted.
 */
async function rApps() {
  const p = $("#rpanel");
  p.innerHTML = '<h4>Apps</h4><div class="rmini"><div class="big">◈</div>Manage apps from the ⊕ Store in the left rail.</div>';
}

// Full editor for a file/source connector (Gmail, Slack, Notion…), opened in a center tab. These
// sync read-only into sources/<name>/ - connect a credential, run a sync, view what it filed.
/**
 * Open (or focus) the file/source connector editor in a center tab.
 * @param {string} name - the connector name to edit.
 * @returns {Promise<void>} resolves once the editor has been rendered into the tab.
 */
async function openConnectorEditor(name) {
  const ex = S.tabs.find((t) => t.type === "conn" && t.name === name);
  if (ex) {
    activateTab(ex.id);
    return;
  }
  const tab = addTab({ type: "conn", title: name, name });
  tab.pane.className = "pane editorpane on";
  tab.pane.innerHTML = "loading…";
  await renderConnectorEditor(tab, name);
}

/**
 * Build the file/source connector editor's markup (metadata + auth/sync/disconnect controls) and
 * wire its buttons: connect-with-token, OAuth authorize (with a poll for the callback), sync now,
 * view filed material, and disconnect.
 * @param {object} tab - the tab whose `.pane` the editor is rendered into.
 * @param {string} name - the connector being edited.
 * @returns {Promise<void>} resolves once the editor is rendered and wired.
 */
async function renderConnectorEditor(tab, name) {
  let cs = [];
  try {
    cs = (await getJSON("/api/connectors")).connectors;
  } catch (e) {}
  const c = cs.find((x) => x.name === name);
  if (!c) {
    tab.pane.innerHTML = '<div class="empty">Connector “' + esc(name) + "” is unavailable.</div>";
    return;
  }
  // The team root is the first non-"core" root (falls back to "team"); filed material lands under it.
  const teamRoot = (S.config.roots || []).map((r) => r.name).find((n) => n !== "core") || "team";
  const st = c.needsAuth ? '<span class="pill warn">needs sign-in</span>' : (c.connected ? '<span class="pill ok">connected</span>' : '<span class="pill">off</span>');
  let html =
    '<div class="editor mcpedit"><div class="dh">⇄ ' +
    esc(name) +
    " " +
    st +
    "</div>" +
    '<p class="ehint">' +
    esc(c.description || "") +
    ' This is a <b>read-only source</b>: it files material into <code>sources/' +
    esc(name) +
    '/</code> and never sends - outward actions always go through the Pending gate.</p>' +
    '<div class="metarow"><span class="metak">Auth</span> ' +
    esc(c.auth || "-") +
    "</div>" +
    '<div class="metarow"><span class="metak">Cadence</span> every ' +
    esc(c.cadence || "-") +
    "</div>" +
    '<div class="metarow"><span class="metak">Last sync</span> ' +
    (c.lastSync ? esc(String(c.lastSync).replace("T", " ").slice(0, 16)) : "never") +
    "</div>";
  const prov = name.charAt(0).toUpperCase() + name.slice(1);
  if (c.auth === "oauth" && c.needsAuth) {
    // OAuth connector with a client configured: sign in via the provider, no token pasting.
    // Takes precedence over "connected" - a seeded source can exist while live access still needs auth.
    html +=
      '<div class="ebar" style="margin-top:18px"><button class="mini auth">Authorize with ' +
      esc(prov) +
      " →</button>" +
      (c.connected ? '<button class="mini ghost view">View filed</button>' : "") +
      '<span class="emsg"></span></div>' +
      '<p class="ehint sub2">Opens ' +
      esc(prov) +
      " in your browser to sign in. BuildEx never sees your password - it receives a read-only token, stored in your keychain, that you can revoke anytime.</p>";
  } else if (c.connected) {
    html += '<div class="ebar" style="margin-top:18px"><button class="mini sync">Sync now</button><button class="mini ghost view">View filed</button><button class="mini ghost disc">Disconnect</button><span class="emsg"></span></div>';
  } else {
    html +=
      '<label style="margin-top:18px">Access token <span class="sub2">(demo: any text works)</span><input class="f-cred" placeholder="Paste an access token"></label>' +
      '<div class="ebar"><button class="mini save">Connect</button><span class="emsg"></span></div>';
  }
  html += "</div>";
  tab.pane.innerHTML = html;
  const msg = $(".emsg", tab.pane);
  // Token connect: POST the pasted credential (defaults to "demo-token"), then repaint.
  const sv = $(".save", tab.pane);
  if (sv)
    sv.onclick = async () => {
      const t = $(".f-cred", tab.pane).value.trim() || "demo-token";
      msg.textContent = "Connecting…";
      try {
        const r = await postJSON("/api/connectors/" + encodeURIComponent(name) + "/connect", { credential: t });
        if (r && r.error) {
          msg.innerHTML = '<span class="bad">' + esc(r.error) + "</span>";
          return;
        }
      } catch (e) {
        msg.innerHTML = '<span class="bad">failed</span>';
        return;
      }
      if (S.rightTab === "apps") rApps();
      renderConnectorEditor(tab, name);
    };
  // OAuth authorize: open the provider's sign-in, then poll the catalog until the callback lands
  // the token (or give up quietly after ~1 min).
  const az = $(".auth", tab.pane);
  if (az)
    az.onclick = async () => {
      az.disabled = true;
      msg.textContent = "Starting…";
      let r;
      try {
        r = await postJSON("/api/connectors/" + encodeURIComponent(name) + "/authorize", {});
      } catch (e) {
        msg.innerHTML = '<span class="bad">failed</span>';
        az.disabled = false;
        return;
      }
      if (!r || r.error) {
        msg.innerHTML = '<span class="bad">' + esc((r && r.error) || "failed") + "</span>";
        az.disabled = false;
        return;
      }
      window.open(r.authorizeUrl, "_blank", "noopener"); // Electron routes this to the OS browser
      msg.innerHTML = '<span class="warn">Complete sign-in in your browser…</span>';
      // Poll until the callback lands the token (or give up quietly after ~1 min).
      let tries = 30;
      const iv = setInterval(async () => {
        tries--;
        let cat = [];
        try {
          cat = (await getJSON("/api/connectors")).connectors;
        } catch (e) {}
        const me = cat.find((x) => x.name === name);
        if ((me && me.connected) || tries <= 0) {
          clearInterval(iv);
          if (S.rightTab === "apps") rApps();
          renderConnectorEditor(tab, name);
        }
      }, 2000);
    };
  // Sync now: trigger a one-off sync and report how many items were filed.
  const sy = $(".sync", tab.pane);
  if (sy)
    sy.onclick = async () => {
      sy.disabled = true;
      sy.textContent = "Syncing…";
      try {
        const r = await postJSON("/api/connectors/" + encodeURIComponent(name) + "/sync", {});
        msg.innerHTML = '<span class="good">Filed ' + ((r && r.wrote) || 0) + " ✓</span>";
      } catch (e) {
        msg.innerHTML = '<span class="bad">sync failed</span>';
      }
      sy.disabled = false;
      sy.textContent = "Sync now";
      if (S.rightTab === "apps") rApps();
      setTimeout(() => renderConnectorEditor(tab, name), 800);
    };
  // View filed: open the source's STATUS.md in a doc tab.
  const vw = $(".view", tab.pane);
  if (vw) vw.onclick = () => openDocTab(teamRoot + "/sources/" + name + "/STATUS.md");
  // Disconnect: revoke the connector, then repaint.
  const dc = $(".disc", tab.pane);
  if (dc)
    dc.onclick = async () => {
      dc.disabled = true;
      try {
        await postJSON("/api/connectors/" + encodeURIComponent(name) + "/disconnect", {});
      } catch (e) {}
      if (S.rightTab === "apps") rApps();
      renderConnectorEditor(tab, name);
    };
}
