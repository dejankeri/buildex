"use strict";
// Right rail switcher: Files tree, agent health, sync log.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Renders whichever right-rail panel is selected into `#rpanel`. State it reads/writes on the
// shared global `S`: `S.rightTab` (which panel is showing), `S.tree` (repo file tree),
// `S.treeFilter` (the Files find-box query), `S.showAgentFiles` (whether the derived `.claude`
// surface is revealed), `S.agentView` (that derived surface, lazily fetched), and `S.config`
// (repo roots, for labelling change-log chips).

/* ---------- right rail ---------- */

/**
 * Switch the right rail to panel `name`: mark it active, un-collapse the rail, and render it.
 * @param {string} name - one of files/skills/automations/apps/pending/synclog.
 */
function switchRight(name) {
  S.rightTab = name;
  $(".app").classList.remove("rc");
  /* clicking a panel icon re-opens a collapsed panel */
  $$("#rtabs button[data-r]").forEach((b) => {
    const sel = b.dataset.r === name;
    b.classList.toggle("on", sel);
    b.setAttribute("aria-selected", sel ? "true" : "false"); // keep the tablist state perceivable
  });
  ({ files: rFiles, skills: rSkills, automations: rAuto, apps: rApps, pending: rPending, synclog: rSyncLog }[name] || rFiles)();
}

/** Fetch the repo file tree into `S.tree` (empty on failure). */
async function loadTree() {
  try {
    S.tree = (await getJSON("/api/tree")).tree;
  } catch (e) {
    S.tree = [];
  }
}

/** Render the Files panel: header, find box, agent-health strip, and the tree host. */
function rFiles() {
  const p = $("#rpanel");
  p.innerHTML = '<div class="rhead"><h4>Files</h4><button class="cog" id="filesCog" title="Files settings">⚙</button></div><div class="findwrap"><input class="find" placeholder="Find files…"></div><div id="agenthealth"></div><div class="tree" id="tree"></div>';
  $(".find", p).oninput = (e) => {
    S.treeFilter = e.target.value.toLowerCase();
    renderTree();
  };
  $("#filesCog").onclick = openFilesSettings;
  // when agent files are shown, load that derived surface first so the tree draws it in one pass.
  if (S.showAgentFiles) loadAgentView().then(renderTree);
  else renderTree();
}

/** Fetch the derived agent surface (`.claude`) into `S.agentView` (null on failure). */
async function loadAgentView() {
  try {
    S.agentView = await getJSON("/api/agent-view");
  } catch (e) {
    S.agentView = null;
  }
}

/* Small Files-panel settings dialog - reveal the derived agent surface (.claude) the agent hooks
   onto, so the operator can confirm every skill (incl. app-pack skills) + pinned tool landed. */
function openFilesSettings() {
  const bd = elt("div", "ovbackdrop");
  bd.innerHTML = '<div class="ovcard"><h3 class="ovh">Files settings</h3>'
    + '<label class="ovtoggle"><input type="checkbox" id="agToggle"' + (S.showAgentFiles ? " checked" : "") + '> Show agent files (<code>.claude</code>)</label>'
    + '<p class="ovp">Reveals what your agent hooks onto - linked skills (with their origin), pinned MCP tools, the policy preset, and the assembled CLAUDE.md. Read-only; regenerated on every sync.</p>'
    + '<div class="ovrow"><button class="mini ovclose">Done</button></div></div>';
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.onclick = (e) => {
    if (e.target === bd) close();
  };
  $(".ovclose", bd).onclick = close;
  $("#agToggle", bd).onchange = async (e) => {
    S.showAgentFiles = e.target.checked;
    // persist the toggle so the choice survives reloads; ignore private-mode storage failures.
    try {
      localStorage.setItem("buildex.showAgentFiles", S.showAgentFiles ? "1" : "0");
    } catch (_) {}
    if (S.showAgentFiles && !S.agentView) await loadAgentView();
    renderTree();
  };
}

/** Render the agent-health strip (skills/MCP/policy counts) above the tree; blank when hidden. */
function renderAgentHealth() {
  const host = $("#agenthealth");
  if (!host) return;
  if (!S.showAgentFiles || !S.agentView) {
    host.innerHTML = "";
    return;
  }
  const s = S.agentView.summary || {}, sk = s.skills || { byRoot: {} }, mcp = s.mcp || {};
  const roots = Object.entries(sk.byRoot || {}).map(([r, n]) => esc(r) + " " + n).join(" · ");
  host.innerHTML = '<div class="aghealth">'
    + '<div class="agline"><b>' + (sk.total || 0) + '</b> skills linked' + (roots ? ' · ' + roots : '') + (sk.fromPacks ? ' · <b>' + sk.fromPacks + '</b> from apps' : '') + '</div>'
    + '<div class="agline"><b>' + (mcp.total || 0) + '</b> MCP pinned' + (mcp.fromPacks ? ' · ' + mcp.fromPacks + ' from apps' : '') + ' · policy ' + (s.policyOk ? '✓' : '✗') + ' · CLAUDE.md ' + (s.claudeMdOk ? '✓' : '✗') + '</div>'
    + '</div>';
}

/* clicking the sync dot opens this: a log of what the brain committed, and when */
function rSyncLog() {
  const p = $("#rpanel");
  p.innerHTML = '<div class="rhead"><h4>Change log - what synced, and when</h4><button class="radd" id="clRefresh" title="Refresh">↻</button></div><div class="bmap" id="rl"><div class="bempty">Loading…</div></div>';
  $("#clRefresh").onclick = () => fillSyncLog();
  fillSyncLog();
}

/** Fetch recent commits and render them as change cards, skipping a rebuild when nothing changed. */
async function fillSyncLog() {
  const bm = $("#rl");
  if (!bm) return;
  let changes;
  try {
    changes = (await getJSON("/api/changes")).changes || [];
  } catch (e) {
    if (bm.querySelector(".bempty")) bm.innerHTML = '<div class="bempty">Couldn’t load recent changes.</div>';
    return;
  }
  if (S.rightTab !== "synclog" || !$("#rl")) return; // switched away while the fetch was in flight
  const top = changes.length ? String(changes[0].sha) : "";
  if (bm.dataset.filled === "1" && bm.dataset.top === top) return; // nothing new - don't rebuild (avoids flicker/scroll reset)
  bm.dataset.filled = "1";
  bm.dataset.top = top;
  bm.innerHTML = "";
  if (!changes.length) {
    bm.innerHTML = '<div class="bempty">No commits yet. As changes land, they show up here.</div>';
    return;
  }
  // chips deep-link into the first writable (non-core) repo, falling back to a "team" label.
  const teamRoot = (S.config.roots || []).map((r) => r.name).find((n) => n !== "core") || "team";
  changes.forEach((ch) => {
    const card = elt("div", "bdiff");
    let chips = "";
    (ch.files || []).slice(0, 4).forEach((f) => {
      chips += '<span class="bchip" data-f="' + escAttr(f) + '">' + esc(f) + '</span>';
    });
    card.innerHTML = '<div class="bds">' + esc(ch.subject) + '</div><div class="bdm">' + esc(ch.author || "") + ' · ' + btime(ch.at) + ' · ' + esc(String(ch.sha).slice(0, 7)) + '</div>' + (chips ? '<div class="bdf">' + chips + '</div>' : '');
    $$(".bchip", card).forEach((ch2) => ch2.onclick = () => openDocTab(teamRoot + "/" + ch2.dataset.f));
    bm.appendChild(card);
  });
}

/** Render the file tree into `#tree`: the derived agent surface (if shown) first, then the repos. */
function renderTree() {
  renderAgentHealth();
  const host = $("#tree");
  if (!host) return;
  host.innerHTML = "";
  const note = (n) => n.note ? '<span class="tnote">' + esc(n.note) + '</span>' : '';
  const draw = (nodes, parent) => {
    nodes.forEach((n) => {
      if (n.type === "file" && S.treeFilter && !n.path.toLowerCase().includes(S.treeFilter)) return;
      const node = elt("div", "tnode" + (n.agent ? " agent" : ""));
      if (n.type === "dir") {
        const kids = (n.children || []);
        const row = elt("div", "trow", '<span class="caret">▼</span><span class="tg">' + (n.agent ? "⚙" : "▸") + '</span><span>' + esc(n.name) + '</span>' + note(n));
        row.onclick = () => node.classList.toggle("closed");
        node.appendChild(row);
        const ch = elt("div", "tchildren");
        node.appendChild(ch);
        draw(kids, ch);
        // hide an empty directory when filtering, unless the directory name itself matches.
        if (S.treeFilter && !ch.children.length && !n.name.toLowerCase().includes(S.treeFilter)) return;
      } else {
        const row = elt("div", "trow", '<span class="caret" style="visibility:hidden">▸</span><span class="tg">' + (n.name.endsWith(".md") ? "▪" : "·") + '</span><span>' + esc(n.name) + '</span>' + note(n));
        row.onclick = () => openDocTab(n.path);
        node.appendChild(row);
      }
      parent.appendChild(node);
    });
  };
  // Draw the synthetic derived node FIRST (above the repo roots) - it's what the operator toggled on
  // to inspect, so it shouldn't be buried below the whole tree.
  if (S.showAgentFiles && S.agentView && S.agentView.tree) {
    S.agentView.tree.forEach((n) => n.agent = true); // ⚙ accent on the synthetic root
    draw(S.agentView.tree, host);
  }
  draw(S.tree, host);
}
