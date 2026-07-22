"use strict";
// Right rail switcher: Files tree, agent health, sync log.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Renders whichever right-rail panel is selected into `#rpanel`. State it reads/writes on the
// shared global `S`: `S.rightTab` (which panel is showing), `S.tree` (repo file tree),
// `S.treeFilter` (the Files find-box query), `S.showAllFiles` (whether the shared `core` library and
// the derived `.claude` surface are revealed), `S.agentView` (that derived surface, lazily fetched),
// and `S.config` (repo roots, for labelling change-log chips).

/* ---------- right rail ---------- */

// The right panel is two surfaces now: "brain" (the map) and "documents" (files + drives). Legacy
// panel names still RESOLVE — a persisted S.rightTab from an older build, or a caller that still asks
// for "pending"/"synclog"/"skills"/"files" — so an upgrade never lands the operator on a blank panel.
// Pending/Skills/Sync folded into the brain's Gate/Policy/Learning stages, so they route to the map.
const RIGHT_PANELS = { brain: rBrain, documents: rDocs };
const RIGHT_ALIASES = { files: "documents", skills: "brain", pending: "brain", synclog: "brain", automations: "brain" };

/**
 * Switch the right rail to panel `name`: mark it active, un-collapse the rail, and render it.
 * @param {string} name - "brain" | "documents" (legacy files/skills/pending/synclog/automations map on).
 */
function switchRight(name) {
  const panel = RIGHT_PANELS[name] ? name : (RIGHT_ALIASES[name] || "brain");
  S.rightTab = panel;
  $(".app").classList.remove("rc");
  /* clicking a panel icon re-opens a collapsed panel */
  $$("#rtabs button[data-r]").forEach((b) => {
    const sel = b.dataset.r === panel;
    b.classList.toggle("on", sel);
    b.setAttribute("aria-selected", sel ? "true" : "false"); // keep the tablist state perceivable
  });
  (RIGHT_PANELS[panel] || rBrain)();
}

/** Fetch the repo file tree into `S.tree` (empty on failure). */
async function loadTree() {
  try {
    S.tree = (await getJSON("/api/tree")).tree;
  } catch (e) {
    S.tree = [];
  }
}

/** Render the Documents panel: two zones over one browser — "In your repo" (light, git-synced files:
 *  the existing Company/Private tree) and "Connected" (external drives — Drive/Dropbox — where media
 *  and heavy files live, out of the synced repo). Header, find box, agent-health strip, tree host. */
function rDocs() {
  const p = $("#rpanel");
  p.innerHTML = '<div class="rhead"><h4>Documents</h4><button class="cog" id="filesCog" title="Documents settings">⚙</button></div>'
    + '<div class="findwrap"><input class="find" placeholder="Find files…"></div><div id="agenthealth"></div>'
    + '<div class="dzone"><div class="dzone-h"><span class="dzone-t">In your repo</span><span class="dzone-b">synced</span></div><div class="tree" id="tree"></div></div>'
    + '<div class="dzone dzone-ext"><div class="dzone-h"><span class="dzone-t">Connected</span><span class="dzone-b">external</span></div><div id="extdrives"></div></div>';
  $(".find", p).oninput = (e) => {
    S.treeFilter = e.target.value.toLowerCase();
    renderTree();
  };
  $("#filesCog").onclick = openFilesSettings;
  renderExternalDrives();
  // in "show everything" mode the derived surface is part of the tree - load it first, draw once.
  if (S.showAllFiles) loadAgentView().then(renderTree);
  else renderTree();
}

// Alias: an older build (or a caller) that still says "files" lands on the same Documents panel.
const rFiles = rDocs;

/* ---------- Connected (external) storage — the seam for Drive/Dropbox/etc. (invariant #10) ----------
   Day one there is one live backend: the synced repo. External drives are an interface with a stub
   that reports none connected, so the zone renders honestly ("nothing connected yet") and the media
   guard has somewhere real to route heavy files the moment a drive IS wired in. */

/** The connected external drives (none in the stub). */
function externalDrives() {
  return (S.extStore && S.extStore.drives) || [];
}

/** Render the Connected zone: each drive, or an honest empty state, plus the connect affordance. */
function renderExternalDrives() {
  const host = $("#extdrives");
  if (!host) return;
  host.innerHTML = "";
  const drives = externalDrives();
  if (!drives.length) {
    host.appendChild(elt("div", "dext-empty", "No drives connected. Media and large files live here — out of your synced repo — once you connect one."));
  } else {
    drives.forEach((dr) => host.appendChild(elt("div", "btool", '<span class="bdot live"></span> <code>' + esc(dr.name || "drive") + "</code><span class=\"btd\">" + esc(dr.provider || "") + "</span>")));
  }
  const add = elt("button", "dext-add", "+ Connect a drive");
  add.onclick = () => connectDrive();
  host.appendChild(add);
}

/** Connect an external drive. The provider wiring (OAuth to Drive/Dropbox) is the cloud path; today
 *  this names the seam rather than pretending to open a provider the console can't yet reach. */
function connectDrive() {
  toast("Connecting a drive (Google Drive, Dropbox) is coming — media will live there, never in your synced repo.");
}

// The media guard. The synced repo carries only light, diff-able, sync-friendly files; everything
// heavy is referenced from an external drive, never committed (invariant #2). This pure classifier is
// the whole rule, unit-tested in isolation.
const REPO_EXTS = ["md", "markdown", "txt", "text", "csv", "tsv", "json", "yaml", "yml", "toml"];
const REPO_MAX_BYTES = 512 * 1024; // 512 KB — a light document, not a media asset

/**
 * Where a dropped/uploaded file belongs.
 * @param {{name?:string,size?:number}} file
 * @returns {"repo"|"external"|"held"} repo = light+small, syncs; external = routed to a connected
 *   drive; held = no drive yet, so it is declined-with-guidance (the operator's own copy is untouched,
 *   so nothing is lost — invariant #8 — and a "connect a drive" prompt tells them where it should go).
 */
function classifyDrop(file) {
  const name = (file && file.name) || "";
  const size = (file && file.size) || 0;
  // A leading dot (".gitignore") is not an extension; only a dot AFTER the first char delimits one.
  // So dotfiles and extension-less files (README, Dockerfile, LICENSE) read as ext "" — light text
  // that belongs in the repo, not declined to a drive.
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const light = (ext === "" || REPO_EXTS.includes(ext)) && size <= REPO_MAX_BYTES;
  if (light) return "repo";
  return externalDrives().length ? "external" : "held";
}

/** Fetch the derived agent surface (`.claude`) into `S.agentView` (null on failure). */
async function loadAgentView() {
  try {
    S.agentView = await getJSON("/api/agent-view");
  } catch (e) {
    S.agentView = null;
  }
}

/* Small Files-panel settings dialog - ONE switch for everything the panel hides by default: the
   shared BuildEx library (`core`, which nobody edits) and the derived agent surface (`.claude`).
   Both are machinery, not the operator's work, so the default view is just their own two brains. */
function openFilesSettings() {
  const bd = elt("div", "ovbackdrop");
  bd.innerHTML = '<div class="ovcard"><h3 class="ovh">Files settings</h3>'
    + '<label class="ovtoggle"><input type="checkbox" id="agToggle"' + (S.showAllFiles ? " checked" : "") + "> Show everything</label>"
    + '<p class="ovp">Normally you see just your two brains - <b>Company</b> and <b>Private</b>. Turn this on to also see the shared BuildEx library (<code>core</code>) and what your agent hooks onto (<code>.claude</code>): linked skills with their origin, pinned MCP tools, the policy preset, and the assembled CLAUDE.md. Both are read-only and regenerated on every sync.</p>'
    + '<div class="ovrow"><button class="mini ovclose">Done</button></div></div>';
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.onclick = (e) => {
    if (e.target === bd) close();
  };
  $(".ovclose", bd).onclick = close;
  $("#agToggle", bd).onchange = async (e) => {
    S.showAllFiles = e.target.checked;
    // persist the toggle so the choice survives reloads; ignore private-mode storage failures.
    try {
      localStorage.setItem("buildex.showAllFiles", S.showAllFiles ? "1" : "0");
    } catch (_) {}
    if (S.showAllFiles && !S.agentView) await loadAgentView();
    renderTree();
  };
}

/** Render the agent-health strip (skills/MCP/policy counts) above the tree; blank when hidden. */
function renderAgentHealth() {
  const host = $("#agenthealth");
  if (!host) return;
  if (!S.showAllFiles || !S.agentView) {
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

/** Render the file tree into `#tree` as labelled sections: Company, then Private, then - only in
 *  "show everything" mode - the shared core library and the derived agent surface. */
function renderTree() {
  renderAgentHealth();
  const host = $("#tree");
  if (!host) return;
  host.innerHTML = "";
  const note = (n) => n.note ? '<span class="tnote">' + esc(n.note) + '</span>' : '';
  const draw = (nodes, parent, depth) => {
    nodes.forEach((n) => {
      if (n.type === "file" && S.treeFilter && !n.path.toLowerCase().includes(S.treeFilter)) return;
      const node = elt("div", "tnode" + (n.agent ? " agent" : ""));
      // Read-only surfaces (the core library, the derived .claude view) get no edit affordances -
      // offering a ＋ that the daemon would refuse is worse than offering nothing.
      const editable = !n.agent && rootSlot(String(n.path).split("/")[0]) !== "core";
      if (n.type === "dir") {
        const kids = (n.children || []);
        // The caret already says "folder, and whether it's open" - a second ▸ next to it said nothing
        // the caret didn't. The ⚙ stays: it BADGES the derived agent surface, which the caret can't.
        const row = elt("div", "trow", '<span class="caret">▼</span>' + (n.agent ? '<span class="tg">⚙</span>' : "") + "<span>" + esc(n.name) + "</span>" + note(n) + (editable ? treeActions() : ""));
        row.onclick = () => toggleTreeNode(node, n.path);
        // Open/closed is remembered per path, so creating a file inside a folder doesn't fold it shut
        // on the repaint. Default: a section's top level is closed (so both brains fit on screen),
        // anything deeper is open. While filtering everything is open - the hits are the point.
        const remembered = S.treeOpen[n.path];
        const open = S.treeFilter ? true : remembered === undefined ? depth > 0 && !n.collapsed : remembered;
        if (!open) node.classList.add("closed");
        node.appendChild(row);
        const ch = elt("div", "tchildren");
        node.appendChild(ch);
        draw(kids, ch, depth + 1);
        if (editable) wireTreeActions(row, n.path, "folder");
        // hide an empty directory when filtering, unless the directory name itself matches.
        if (S.treeFilter && !ch.children.length && !n.name.toLowerCase().includes(S.treeFilter)) return;
      } else {
        // No glyph on a file either - ".md" is already in the name. The hidden caret stays as a
        // spacer so file names line up with the folder names above them.
        const row = elt("div", "trow", '<span class="caret" style="visibility:hidden">▸</span><span>' + esc(n.name) + "</span>" + note(n) + (editable ? '<span class="tacts"><button class="tact tmore" title="More">⋯</button></span>' : ""));
        row.onclick = () => openDocTab(n.path);
        node.appendChild(row);
        if (editable) wireTreeActions(row, n.path, "file");
      }
      parent.appendChild(node);
    });
  };
  // A repo root is drawn as a SECTION, not as a folder: the operator thinks "company files" and "my
  // files", never "the team-acme repo". The root node itself disappears and its children sit under a
  // labelled heading, so the two brains - and the boundary between them - are unmissable.
  const section = (title, sub, nodes, cls, root) => {
    if (!nodes.length && !root) return;
    // A section's ＋ buttons create at the ROOT of that brain - the one place a top-level folder can
    // come from. No ⋯: deleting a whole brain is an org-level act, not a file-manager one.
    const hd = elt("div", "tsec" + (cls ? " " + cls : ""), '<span class="tsec-t">' + esc(title) + '</span><span class="tsec-s">' + esc(sub) + "</span>" + (root ? treeActions(true) : ""));
    const body = elt("div", "tsec-b");
    host.append(hd, body);
    draw(nodes, body, 0);
    if (root) wireTreeActions(hd, root, "section");
    // A section the find-box emptied shows no heading either - a bare "Private" over nothing reads
    // as "you have no private files", which is a different (and wrong) statement.
    if (S.treeFilter && !body.children.length) {
      hd.remove();
      body.remove();
    }
  };
  const rootsOf = (slot) => S.tree.filter((n) => rootSlot(n.name) === slot);
  const kidsOf = (slot) => rootsOf(slot).flatMap((n) => n.children || []);
  const rootName = (slot) => (rootsOf(slot)[0] || {}).name;
  section("Company", "shared with your team", kidsOf("team"), "", rootName("team"));
  section("Private", "only you", kidsOf("private"), "", rootName("private"));
  // Anything that is neither team, private nor core - a hand-added repo, or a tree shape this build
  // doesn't recognise - is still the operator's data: draw it plainly rather than hide it.
  const other = S.tree.filter((n) => !["team", "private", "core"].includes(rootSlot(n.name)));
  if (other.length) {
    const body = elt("div", "tsec-b");
    host.appendChild(body);
    draw(other, body, 0);
  }
  // Everything below is machinery, shown only behind the "Show everything" switch (⚙ in the header).
  if (!S.showAllFiles) return;
  section("BuildEx library", "read-only", kidsOf("core"), "tsec-sys");
  if (S.agentView && S.agentView.tree) {
    S.agentView.tree.forEach((n) => n.agent = true); // ⚙ accent on the synthetic root
    section("Agent files", "derived, read-only", S.agentView.tree, "tsec-sys");
  }
}

/** Toggle a folder open/closed AND remember it, so the next repaint (after a create/delete) keeps
 *  the operator where they were instead of snapping the tree shut. */
function toggleTreeNode(node, path) {
  const closed = node.classList.toggle("closed");
  S.treeOpen[path] = !closed;
}

// Inline icons (the right rail already draws its tabs this way): folder-plus and file-plus. Drawn as
// strokes so they inherit the row's colour and stay legible at 14px in either theme.
const IC_FOLDER_PLUS = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>';
const IC_FILE_PLUS = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>';

/** The action cluster shown on a folder row / section heading. `noMore` drops the ⋯ (a section is a
 *  repo root - it can hold new things, but it is not itself deletable from here). */
function treeActions(noMore) {
  return '<span class="tacts"><button class="tact tmkdir" title="New folder">' + IC_FOLDER_PLUS + '</button>'
    + '<button class="tact tmkfile" title="New file">' + IC_FILE_PLUS + "</button>"
    + (noMore ? "" : '<button class="tact tmore" title="More">⋯</button>') + "</span>";
}

/**
 * Wire an action cluster. Every handler stops propagation - the row itself opens a doc or folds a
 * folder, and a ＋ must never do both.
 * @param {HTMLElement} row - the row (or section heading) holding the cluster.
 * @param {string} path - the folder this cluster acts INSIDE (for a file's ⋯, the file itself).
 * @param {string} kind - "folder" | "section" | "file".
 */
function wireTreeActions(row, path, kind) {
  const on = (sel, fn) => {
    const b = $(sel, row);
    if (b) b.onclick = (e) => {
      e.stopPropagation();
      fn(e);
    };
  };
  on(".tmkdir", () => promptAction({
    title: "New folder",
    label: "Folder name",
    placeholder: "clients",
    onConfirm: (name) => fsDo("/api/fs/folder", { path: path + "/" + name }, path),
  }));
  on(".tmkfile", (e) => openFileMenu(e.currentTarget, path));
  on(".tmore", (e) => openTreeMoreMenu(e.currentTarget, path, kind));
}

/** The ＋file mini-menu: write a new document, or bring a file in from the operator's machine. */
function openFileMenu(anchor, dir) {
  closeMenus();
  const m = elt("div", "dropdown");
  const doc = elt("button", null, '<span class="k">▤</span>New document');
  doc.onclick = () => {
    closeMenus();
    promptAction({
      title: "New document",
      label: "File name",
      placeholder: "notes.md",
      // A brain is markdown: a name with no extension gets .md rather than an extensionless file
      // nothing can render. An explicit extension is always honoured.
      onConfirm: (name) => {
        const file = /\.[a-z0-9]+$/i.test(name) ? name : name + ".md";
        const p = dir + "/" + file;
        fsDo("/api/fs/file", { path: p, content: "# " + file.replace(/\.md$/i, "") + "\n" }, dir, () => openDocTab(p));
      },
    });
  };
  const up = elt("button", null, '<span class="k">⇧</span>Upload a file…');
  up.onclick = () => {
    closeMenus();
    uploadIntoFolder(dir);
  };
  m.append(doc, up);
  dropAt(m, anchor);
}

/** The ⋯ menu on a folder or file: today just Delete, which always asks first. */
function openTreeMoreMenu(anchor, path, kind) {
  closeMenus();
  const m = elt("div", "dropdown");
  const name = String(path).split("/").pop();
  const del = elt("button", null, '<span class="k">⌫</span>Delete ' + (kind === "file" ? "file" : "folder"));
  del.onclick = () => {
    closeMenus();
    confirmAction({
      title: "Delete " + (kind === "file" ? "this file?" : "this folder?"),
      body: kind === "file"
        ? "“" + name + "” is removed from your brain. It stays in this repo's history, so it can be recovered."
        : "“" + name + "” and everything inside it are removed from your brain. They stay in this repo's history, so they can be recovered.",
      confirm: "Delete",
      onConfirm: () => fsDo("/api/fs/delete", { path }, null, () => {
        // If what was deleted is open in the middle column, close it - a tab onto a file that no
        // longer exists is a trap.
        const t = S.tabs.find((x) => x.type === "doc" && (x.path === path || String(x.path).startsWith(path + "/")));
        if (t) closeTab(t.id);
      }),
    });
  };
  m.appendChild(del);
  dropAt(m, anchor);
}

/** Pin a menu to an anchor's viewport position (the tree scrolls inside an overflow container, so an
 *  absolutely-positioned menu would be clipped - same reason projectMenu does this). */
function dropAt(m, anchor) {
  document.body.appendChild(m);
  m.dataset.menu = "1";
  const r = anchor.getBoundingClientRect();
  m.style.position = "fixed";
  m.style.top = Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8) + "px";
  m.style.left = Math.max(8, Math.min(r.left - 40, window.innerWidth - m.offsetWidth - 8)) + "px";
}

/** Pick file(s) from the operator's machine and bring them in — light ones into the synced repo, media
 *  and heavy ones routed to a connected drive (or declined-with-guidance when none is connected). The
 *  synced repo never takes an asset that would bloat git (classifyDrop is the rule). */
function uploadIntoFolder(dir) {
  const inp = elt("input");
  inp.type = "file";
  inp.multiple = true;
  inp.onchange = async () => {
    for (const f of Array.from(inp.files || [])) {
      const where = classifyDrop(f);
      if (where === "held") {
        // No drive to route it to. Decline rather than bloat the repo — the operator's own copy is
        // untouched (nothing lost). One toast per file; the "Connect a drive" row in the panel is the
        // standing affordance, so we don't stack a second toast on top of this one.
        toast("“" + f.name + "” is too big to sync. Connect a drive to store it — it won’t go in your repo.", true);
        continue;
      }
      if (where === "external") {
        // A drive is connected: the file belongs there, not in git. (Provider upload is the cloud path.)
        toast("“" + f.name + "” goes to your connected drive, not the synced repo.");
        continue;
      }
      // Light + small: it syncs. FileReader gives a data: URL; the base64 payload is after the comma.
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1] || "");
        r.onerror = () => rej(r.error);
        r.readAsDataURL(f);
      }).catch(() => null);
      if (base64 == null) {
        toast("Couldn’t read " + f.name, true);
        continue;
      }
      await fsDo("/api/fs/file", { path: dir + "/" + f.name, base64 }, dir);
    }
  };
  inp.click();
}

/**
 * Run one file op, then repaint from the daemon's tree (never from an optimistic guess - the daemon
 * is the authority on what actually landed). A refusal is surfaced verbatim, because its wording is
 * written for the operator.
 * @param {string} url - the /api/fs/* route.
 * @param {object} b - the request body.
 * @param {string} [openPath] - folder to leave expanded afterwards (where the new thing went).
 * @param {Function} [after] - runs only on success, after the tree is back.
 * @returns {Promise<boolean>} whether the op succeeded.
 */
async function fsDo(url, b, openPath, after) {
  let r;
  try {
    r = await postJSON(url, b);
  } catch (e) {
    toast("Couldn’t reach the app", true);
    return false;
  }
  if (r && r.error) {
    toast(r.error, true);
    return false;
  }
  if (openPath) S.treeOpen[openPath] = true; // show the operator what they just made
  await loadTree();
  renderTree();
  if (after) after();
  return true;
}

/**
 * Map a repo root's raw name to its slot. Root names are company-suffixed in a provisioned workspace
 * ("team-acme", "private-you") but bare in the real product - mirrors slotOf() in brain/catalog.ts,
 * which is the server-side authority on the same question.
 * @param {string} name - the root's directory name.
 * @returns {string} "core" | "team" | "private" | the name itself.
 */
function rootSlot(name) {
  if (name === "core") return "core";
  if (name === "team" || name.startsWith("team-")) return "team";
  if (name === "private" || name.startsWith("private-")) return "private";
  return name;
}
