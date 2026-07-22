"use strict";
// Agent Context viewer — "what my agent sees".
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
//
// A center tab that shows, deterministically and with zero AI (invariant #9), exactly what the agent
// loads at the start of a new chat: the assembled CLAUDE.md, every linked verb, the pinned MCP servers
// + live tools, and the policy/gate hook — each file readable in place. Its point is CERTAINTY: it
// flags what the operator authored but that never wired in (a SKILL.md that didn't link, a missing
// CLAUDE.md/policy), so they can PROVE the brain reaches Claude. Reads /api/agent-view (+ the gateway
// and connectors for live tools/sources); "Regenerate & re-verify" POSTs /api/agent-view/regen.

/** Open (or re-focus) the Agent Context tab, then load its data. */
function openAgentContextTab() {
  const ex = S.tabs.find((t) => t.type === "agentctx");
  if (ex) {
    activateTab(ex.id);
    loadAgentContext(ex);
    return;
  }
  const tab = addTab({ type: "agentctx", title: "Agent context" });
  tab.pane.className = "pane agentctxpane on";
  tab.pane.innerHTML = '<div class="bloading">Reading what your agent sees…</div>';
  loadAgentContext(tab);
}

/** Fetch the derived agent view + the live gateway (tools) + connectors (sources); stash and render. */
async function loadAgentContext(tab) {
  const [view, gw, conn] = await Promise.all([
    getJSON("/api/agent-view").catch(() => null),
    getJSON("/api/connectors/gateway").catch(() => ({ status: [], tools: [] })),
    getJSON("/api/connectors").catch(() => ({ connectors: [] })),
  ]);
  tab.actx = { view, gw: gw || { status: [], tools: [] }, conn: (conn && conn.connectors) || [], sel: tab.actx && tab.actx.sel };
  renderAgentContext(tab);
}

/** Regenerate the agent config (re-link skills, re-assemble CLAUDE.md, re-pin MCP) then re-render from
 *  the FRESH view — this is the proof step: an operator can watch a just-authored verb become linked. */
async function regenAgentContext(tab) {
  const btn = $(".actx-regen", tab.pane);
  if (btn) { btn.disabled = true; btn.textContent = "Regenerating…"; }
  let view = null;
  try { view = await postJSON("/api/agent-view/regen", {}); } catch (e) {}
  if (view && !view.error) tab.actx.view = view;
  renderAgentContext(tab);
}

/** Render the two-pane viewer: the annotated checklist on the left, the selected file's contents on
 *  the right. Pure over `tab.actx` — the tests drive it directly with a preset payload. */
function renderAgentContext(tab) {
  const d = tab.actx || {};
  const v = d.view;
  if (!v) { tab.pane.innerHTML = '<div class="bempty">Couldn’t read the agent view. Is the app running?</div>'; return; }
  const disc = v.discrepancies || [],
    sk = (v.summary && v.summary.skills) || { total: 0, authored: 0, byRoot: {} },
    mcp = (v.summary && v.summary.mcp) || { total: 0, servers: [] };
  const verdict = disc.length
    ? '<div class="actx-verdict warn">⚠ ' + disc.length + (disc.length === 1 ? " thing needs" : " things need") + ' attention before the agent has the whole brain</div>'
    : '<div class="actx-verdict ok">✓ Everything the agent needs is wired</div>';

  tab.pane.innerHTML =
    '<div class="actx">'
    + '<div class="actx-left">'
    + '<div class="actx-head"><span class="actx-badge" title="Read straight from your repo files - no AI in the loop">derived from your repo · zero AI</span>'
    + '<button class="actx-regen" title="Rebuild the agent config, then re-check">↻ Regenerate &amp; re-verify</button></div>'
    + verdict
    + '<div class="actx-groups" id="actxgroups"></div>'
    + '</div>'
    + '<div class="actx-right" id="actxreader"><div class="actx-empty">Select a file to see exactly what the agent reads.</div></div>'
    + '</div>';
  $(".actx-regen", tab.pane).onclick = () => regenAgentContext(tab);

  const groups = $("#actxgroups", tab.pane);
  const claudePath = "CLAUDE.md", settingsPath = ".claude/settings.json", mcpPath = ".mcp.json";

  // 1) Standing instructions
  const g1 = actxGroup(groups, "Standing instructions", "the always-on rules");
  actxRow(g1, tab, { ok: !!(v.summary && v.summary.claudeMdOk), label: "CLAUDE.md", sub: "assembled rules", path: claudePath });

  // 2) Verbs (skills) — linked, grouped by origin; then any authored-but-unlinked as warnings.
  const g2 = actxGroup(groups, "Verbs", sk.total + " linked" + (sk.authored > sk.total ? " · " + (sk.authored - sk.total) + " not wired" : ""));
  const skillsNode = (v.tree && v.tree[0] && (v.tree[0].children || []).find((c) => String(c.name).startsWith("skills"))) || { children: [] };
  const linkedSkills = skillsNode.children || [];
  if (!linkedSkills.length) g2.appendChild(elt("div", "actx-note", "No verbs linked yet."));
  linkedSkills.forEach((s) => {
    const md = (s.children || []).find((c) => c.name === "SKILL.md");
    actxRow(g2, tab, { ok: true, label: s.name, sub: s.note || "", path: (md && md.path) || (s.path + "/SKILL.md") });
  });
  disc.filter((x) => x.kind === "skill-unlinked").forEach((x) => {
    // path is "<root>/skills/<verb>/SKILL.md" - label with the VERB name (its parent dir), not the file.
    const verb = String(x.path || "").replace(/\/SKILL\.md$/i, "").split("/").pop() || "unlinked verb";
    actxRow(g2, tab, { warn: true, label: verb, sub: "authored but not linked — the agent won’t see it", path: x.path });
  });

  // 3) Tools & connections — the .mcp.json config + the live gateway tools.
  const tools = (d.gw.tools || []).filter((t) => t.kind !== "hidden");
  const g3 = actxGroup(groups, "Tools & connections", mcp.total + " server" + (mcp.total === 1 ? "" : "s") + " · " + tools.length + " live tool" + (tools.length === 1 ? "" : "s"));
  actxRow(g3, tab, { ok: mcp.total > 0, label: ".mcp.json", sub: mcp.total ? mcp.servers.join(", ") : "no MCP servers pinned", path: mcp.total ? mcpPath : null });
  tools.forEach((t) => {
    const conn = t.name.split("__")[0],
      short = t.name.indexOf("__") >= 0 ? t.name.slice(t.name.indexOf("__") + 2) : t.name;
    g3.appendChild(elt("div", "actx-tool", '<span class="pill ' + (t.kind === "gated" ? "warn" : "ok") + '">' + esc(t.kind) + '</span> <code>' + esc(short) + '</code><span class="actx-td">' + esc(conn) + "</span>"));
  });

  // 4) Policy & gate
  const g4 = actxGroup(groups, "Policy & gate", "allow / ask / deny + the gate hook");
  actxRow(g4, tab, { ok: !!(v.summary && v.summary.policyOk), label: "settings.json", sub: "policy + gate hook", path: settingsPath });

  // 5) Sources — read-only connector data filed into the workspace as context.
  const g5 = actxGroup(groups, "Sources", "read-only context the agent can read");
  if (!d.conn.length) g5.appendChild(elt("div", "actx-note", "No sources connected."));
  d.conn.forEach((c) => g5.appendChild(elt("div", "actx-tool", '<span class="bdot ' + (c.connected ? "live" : "off") + '"></span> <code>' + esc(c.name || "source") + "</code>")));

  // restore a selection across a re-render (e.g. after regenerate)
  if (d.sel) actxSelectFile(tab, d.sel);
}

/** Append a titled group to the checklist and return its body element. */
function actxGroup(host, title, sub) {
  const g = elt("div", "actx-group", '<div class="actx-gh"><span class="actx-gt">' + esc(title) + '</span><span class="actx-gs">' + esc(sub) + "</span></div>");
  const body = elt("div", "actx-gb");
  g.appendChild(body);
  host.appendChild(g);
  return body;
}

/** One checklist row: a status glyph (✓ ok / ⚠ warn / ✗ missing), a label, a sub-line, and — when it
 *  maps to a file — a click that loads that file's contents into the right pane. */
function actxRow(body, tab, o) {
  const glyph = o.warn ? "⚠" : o.ok ? "✓" : "✗";
  const cls = o.warn ? "warn" : o.ok ? "ok" : "bad";
  const row = elt("div", "actx-row " + cls + (o.path ? " has" : ""),
    '<span class="actx-g">' + glyph + '</span><span class="actx-l">' + esc(o.label) + "</span>" + (o.sub ? '<span class="actx-s">' + esc(o.sub) + "</span>" : ""));
  if (o.path) {
    row.dataset.path = o.path;
    row.onclick = () => actxSelectFile(tab, o.path);
  }
  body.appendChild(row);
}

/** Load `path` via the root-confined doc reader and render its contents in the right pane; markdown is
 *  rendered, everything else is shown verbatim (escaped) so config files read as config. */
async function actxSelectFile(tab, path) {
  tab.actx.sel = path;
  $$(".actx-row.has", tab.pane).forEach((r) => r.classList.toggle("on", r.dataset.path === path));
  const host = $("#actxreader", tab.pane);
  if (!host) return;
  host.innerHTML = '<div class="actx-rhead"><code>' + esc(path) + "</code></div><div class=\"actx-body\">loading…</div>";
  let content = "";
  try {
    const r = await getJSON("/api/doc?path=" + encodeURIComponent(path));
    content = (r && r.content) || "";
  } catch (e) {
    $(".actx-body", host).innerHTML = '<div class="bempty">Couldn’t read ' + esc(path) + ".</div>";
    return;
  }
  const isMd = /\.(md|markdown)$/i.test(path);
  $(".actx-body", host).innerHTML = isMd ? '<div class="md">' + md(content) + "</div>" : '<pre class="actx-code">' + esc(content) + "</pre>";
}
