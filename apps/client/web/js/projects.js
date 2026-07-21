"use strict";
// Left rail: projects (task containers) + conversations.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Renders and mutates the left-rail projects list (each project is a container of chat/doc/browser/
// map items) and drives the sync dot from the background sync loop's status.
// Reads/writes on the shared `S`: `S.projects`, `S.activeProject`, `S.tabs`, `S.active`,
// `S.rightTab`, `S.config`.

/**
 * Reload projects + sessions from the daemon and repaint the left rail; also refresh the sync dot.
 * @returns {Promise<void>}
 */
async function refreshProjects() {
  let projects, sessions;
  try {
    projects = (await getJSON("/api/projects")).projects;
  } catch (e) {
    setSync("off");
    return;
  }
  // Reflect the background sync loop's status on the dot. An in-flight agent run (syncBusy) wins;
  // otherwise problems take precedence over the unsaved count - needs-help (a conflict was backed
  // up) / queued (offline) / local (no account) / unsaved (waiting on the operator to save) / ok.
  let st = "ok";
  try {
    const s = await getJSON("/api/sync");
    st =
      s.status === "needs-help" ? "help" :
      s.status === "queued" ? "queued" :
      s.status === "local" ? "local" :
      // Only amber when there is somewhere to save TO. Without an account (a fresh install, or the
      // local-only demo sandbox) every file reads as unsaved, and a "click to save" dot would lead
      // to a tray with nothing to click.
      s.unsaved && s.unsaved.connected && s.unsaved.files > 0 ? "unsaved" : "ok";
  } catch (e) {}
  setSync(syncBusy ? "busy" : st);
  if (S.rightTab === "synclog") fillSyncLog();
  try {
    sessions = (await getJSON("/api/sessions")).sessions;
  } catch (e) {
    sessions = [];
  }
  const sMap = {};
  sessions.forEach((s) => sMap[s.id] = s);
  if (!projects.length) {
    await ensureDefaultProject();
    return;
  }
  S.projects = projects;
  if (!S.activeProject || !projects.find((p) => p.id === S.activeProject)) S.activeProject = projects[0].id;
  const host = $("#convos");
  // Preserve each project's collapsed/expanded state across the re-render (keyed by project id).
  const openState = {};
  $$(".project", host).forEach((f) => openState[f.dataset.p] = !f.classList.contains("closed"));
  host.innerHTML = "";
  projects.forEach((p) => {
    const f = elt("div", "project" + (p.id === S.activeProject ? " active" : ""));
    f.dataset.p = p.id;
    if (openState[p.id] === false) f.classList.add("closed");
    const hdr = elt("div", "phdr", '<span class="caret">▼</span><span class="pname">' + esc(p.name) + '</span><span class="pcount">' + p.items.length + '</span><span class="padd" title="New chat in this session">＋</span><span class="pmore" title="Rename / delete">⋯</span>');
    $(".caret", hdr).onclick = (e) => {
      e.stopPropagation();
      f.classList.toggle("closed");
    };
    $(".padd", hdr).onclick = (e) => {
      e.stopPropagation();
      newConversation(p.id);
    };
    $(".pmore", hdr).onclick = (e) => {
      e.stopPropagation();
      projectMenu(p, e.currentTarget);
    };
    hdr.onclick = () => switchToProject(p.id);
    f.appendChild(hdr);
    const list = elt("div", "pitems");
    p.items.forEach((it, idx) => {
      const row = elt("div", "pitem");
      if (it.type === "chat") {
        // Chat rows prefer the live session title/status (from sMap) over the stored item fields.
        const s = sMap[it.sessionId];
        const label = (s && s.title) || it.title || "Chat";
        const active = S.active && S.tabs.find((t) => t.id === S.active && t.sessionId === it.sessionId);
        row.className = "pitem" + (active ? " active" : "");
        row.innerHTML = '<span class="st ' + ((s && s.status) || "idle") + '"></span><span class="pilabel">' + esc(label) + "</span>";
        row.onclick = () => switchToProject(p.id, idx);
      } else {
        const icon = { browser: "◉", doc: "▤", map: "◇" }[it.type] || "◈";
        // Doc → basename; browser → host (scheme stripped, capped); map → literal "Map".
        const label = it.type === "doc" ? String(it.path).split("/").pop() : it.type === "browser" ? (String(it.url).replace(/^https?:\/\//, "").slice(0, 22) || "Browser") : "Map";
        row.innerHTML = '<span class="pic">' + icon + '</span><span class="pilabel">' + esc(label) + "</span>";
        row.onclick = () => switchToProject(p.id, idx);
      }
      const rm = elt("span", "pix", "×");
      rm.title = "Remove from session";
      rm.onclick = (e) => {
        e.stopPropagation();
        removeProjectItem(p.id, idx, it);
      };
      row.appendChild(rm);
      list.appendChild(row);
    });
    if (!p.items.length) list.innerHTML = '<div class="pempty">Empty - add a chat, doc, or browser with ＋ in the header.</div>';
    f.appendChild(list);
    host.appendChild(f);
  });
}

/**
 * Create a first project (named after the company, or "Workspace") when none exist, then re-render.
 * @returns {Promise<void>}
 */
async function ensureDefaultProject() {
  const name = (S.config.company && S.config.company.name) || "Workspace";
  const { project } = await postJSON("/api/projects", { name });
  S.activeProject = project.id;
  await refreshProjects();
}

/**
 * Create a new empty project, select it, re-render, then drop into inline-rename on its header.
 * @returns {Promise<void>}
 */
async function newProject() {
  const { project } = await postJSON("/api/projects", { name: "New session" });
  S.activeProject = project.id;
  await refreshProjects();
  // inline-rename the fresh session
  const hdr = $('.project[data-p="' + project.id + '"] .phdr');
  if (hdr) projectRename(project, hdr);
}

/**
 * Append an item (chat/doc/browser/map) to the active project, then refresh; no-op with no project.
 * @param {object} item - the item descriptor to persist.
 */
function addToActiveProject(item) {
  if (S.activeProject)
    postJSON("/api/projects/" + S.activeProject + "/items", { item })
      .then(() => refreshProjects())
      .catch(() => {});
}

/**
 * Remove item `idx` from project `pid`; if it maps to an open tab, close that too, then re-render.
 * @param {string} pid - project id.
 * @param {number} idx - item index within the project.
 * @param {object} [it] - the removed item descriptor, used to find a matching open tab.
 * @returns {Promise<void>}
 */
async function removeProjectItem(pid, idx, it) {
  try {
    await postJSON("/api/projects/" + pid + "/remove-item", { index: idx });
  } catch (e) {}
  // if the removed item is open as a tab (chat/doc are uniquely identifiable), close it too
  if (it) {
    const t = S.tabs.find((t) => (it.type === "chat" && t.type === "chat" && t.sessionId === it.sessionId) || (it.type === "doc" && t.type === "doc" && t.path === it.path));
    if (t) closeTab(t.id);
  }
  await refreshProjects();
}

/**
 * Pop a rename/delete dropdown for a project, anchored under its ⋯ button.
 * @param {object} p - the project.
 * @param {HTMLElement} anchor - the ⋯ button the menu is positioned beneath.
 */
function projectMenu(p, anchor) {
  closeMenus();
  const m = elt("div", "dropdown");
  [
    ["Rename", () => projectRename(p, anchor.closest(".phdr"))],
    [
      "Delete session",
      async () => {
        await postJSON("/api/projects/" + p.id + "/delete", {});
        if (S.activeProject === p.id) S.activeProject = null;
        refreshProjects();
      },
    ],
  ].forEach(([l, fn]) => {
    const b = elt("button", null, l);
    b.onclick = () => {
      closeMenus();
      fn();
    };
    m.appendChild(b);
  });
  // Anchor to the ⋯ button's real viewport position. The left panel uses overflow:hidden/auto,
  // so a menu placed inside .phdr (which isn't positioned) landed in the wrong spot / got clipped -
  // append to <body> and pin with position:fixed instead.
  document.body.appendChild(m);
  m.dataset.menu = "1";
  const r = anchor.getBoundingClientRect();
  m.style.position = "fixed";
  m.style.top = (r.bottom + 4) + "px";
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
}

/**
 * Swap a project's name label for an inline text input and commit the edit on Enter/blur.
 * @param {object} p - the project being renamed.
 * @param {HTMLElement} hdr - the project's `.phdr` header element containing the name label.
 */
function projectRename(p, hdr) {
  const nameEl = $(".pname", hdr);
  if (!nameEl) return;
  const inp = elt("input", "prename");
  inp.value = p.name;
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  // Commit only a non-empty, changed name; either way re-render to restore the label.
  const done = async (save) => {
    const v = inp.value.trim();
    if (save && v && v !== p.name) {
      await postJSON("/api/projects/" + p.id + "/rename", { name: v });
    }
    refreshProjects();
  };
  inp.onkeydown = (e) => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  };
  inp.onblur = () => done(true);
  inp.onclick = (e) => e.stopPropagation();
}

/**
 * Start a new chat: ensure the target project is active, create a session + project item, open it.
 * @param {string} [pid] - project to create the chat in; switches to it first if not already active.
 * @returns {Promise<void>}
 */
async function newConversation(pid) {
  if (pid && pid !== S.activeProject) await switchToProject(pid);
  const proj = S.projects && S.projects.find((p) => p.id === S.activeProject);
  const folder = (proj && proj.name) || (S.config.company && S.config.company.name) || "Conversations";
  const { id } = await postJSON("/api/sessions", { folder, title: "New chat" });
  if (S.activeProject) await postJSON("/api/projects/" + S.activeProject + "/items", { item: { type: "chat", sessionId: id, title: "New chat" } });
  await refreshProjects();
  openChatTab({ id, title: "New chat", status: "idle" });
}
