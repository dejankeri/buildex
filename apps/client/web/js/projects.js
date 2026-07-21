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
  // otherwise the server's state - needs-help (a conflict was backed up) / queued (offline) / ok.
  let ss = "ok";
  try {
    ss = (await getJSON("/api/sync")).status;
  } catch (e) {}
  setSync(syncBusy ? "busy" : ss === "needs-help" ? "help" : ss === "queued" ? "queued" : ss === "local" ? "local" : ss === "busy" ? "busy" : "ok");
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
  // Newest session first. The store appends on create, so insertion order IS creation order and a
  // reverse is exact - no reliance on createdAt, which older project files may not carry. The rail
  // is a "what am I working on now" list; a session made a minute ago must not land below a year of
  // history. S.projects itself is reordered (not just the DOM) so ⌘[/⌘] cycle in the same order.
  projects = projects.slice().reverse();
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
    // The rail lists a session's CHATS and nothing else - a chat is work you come back to, while a
    // doc or a browser is a view you opened and can close without losing anything. Those live in
    // the middle column's tab bar only. Indexes are carried alongside because the item index (into
    // the unfiltered p.items) is what switchToProject/removeProjectItem address.
    const chats = (p.items || []).map((it, idx) => ({ it, idx })).filter((x) => x.it.type === "chat");
    const st = projectStatus(p, sMap);
    const hdr = elt("div", "phdr", '<span class="caret">▼</span><span class="pdot pd-' + st.k + '" title="' + escAttr(st.why) + '"></span><span class="pname">' + esc(p.name) + '</span><span class="pcount">' + chats.length + '</span><span class="padd" title="Start something in this session">＋</span><span class="pmore" title="Rename / delete">⋯</span>');
    $(".caret", hdr).onclick = (e) => {
      e.stopPropagation();
      f.classList.toggle("closed");
    };
    $(".padd", hdr).onclick = (e) => {
      e.stopPropagation();
      openAddMenu(e.currentTarget, p.id); // same menu as the tab bar's ＋, scoped to this session
    };
    $(".pmore", hdr).onclick = (e) => {
      e.stopPropagation();
      projectMenu(p, e.currentTarget);
    };
    hdr.onclick = () => switchToProject(p.id);
    f.appendChild(hdr);
    const list = elt("div", "pitems");
    chats.forEach(({ it, idx }) => {
      const row = elt("div", "pitem");
      // Chat rows prefer the live session title/status (from sMap) over the stored item fields.
      const s = sMap[it.sessionId];
      const label = (s && s.title) || it.title || "Chat";
      const active = S.active && S.tabs.find((t) => t.id === S.active && t.sessionId === it.sessionId);
      row.className = "pitem" + (active ? " active" : "");
      // A chat started from an app is badged with that app's mark, so "the Stripe chat" is findable
      // at a glance among a session's chats. Plain chats carry no badge.
      const app = it.app ? (S.apps || []).find((a) => a.name === it.app) : null;
      const badge = it.app ? '<span class="pia" title="' + escAttr(((app && app.title) || it.app) + " chat") + '">' + (app ? appGlyph(app) : "◈") + "</span>" : "";
      row.innerHTML = '<span class="st ' + ((s && s.status) || "idle") + '"></span>' + badge + '<span class="pilabel">' + esc(label) + "</span>";
      if (it.app) mountAppLogo($(".pia", row), it.app, "pilogo");
      row.onclick = () => switchToProject(p.id, idx);
      const rm = elt("span", "pix", "×");
      rm.title = "Delete this chat";
      rm.onclick = (e) => {
        e.stopPropagation();
        // Same act as closing the chat's tab, same confirmation - deleting work is never one stray click.
        confirmAction({
          title: "Delete this chat?",
          body: "“" + label + "” and its history are removed from this session.",
          confirm: "Delete chat",
          onConfirm: () => removeProjectItem(p.id, idx, it),
        });
      };
      row.appendChild(rm);
      list.appendChild(row);
    });
    if (!chats.length) list.innerHTML = '<div class="pempty">No chats yet - start one with ＋ in the header.</div>';
    f.appendChild(list);
    host.appendChild(f);
  });
}

/**
 * Roll a session's chats up into ONE traffic light for its collapsed row - the operator has to read
 * a session's state without opening it. Worst state wins, in the order that matters to a human:
 * something broke > something wants me > something is working > everything's done.
 * @param {object} p - the project.
 * @param {Record<string, object>} sMap - live sessions by id (the authority on status).
 * @returns {{k: string, why: string}} dot class + its tooltip.
 */
function projectStatus(p, sMap) {
  const states = (p.items || [])
    .filter((it) => it.type === "chat")
    .map((it) => (sMap[it.sessionId] && sMap[it.sessionId].status) || "idle");
  if (!states.length) return { k: "none", why: "Nothing running in this session yet" };
  const n = (k) => states.filter((s) => s === k).length;
  if (n("error")) return { k: "error", why: n("error") + " of " + states.length + " chats hit an error" };
  if (n("needs-attention")) return { k: "needs-attention", why: n("needs-attention") + " of " + states.length + " chats are waiting on you" };
  if (n("running")) return { k: "running", why: n("running") + " of " + states.length + " chats are working" };
  return { k: "idle", why: "All " + states.length + " chats are done" };
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
 * Create a new empty project, switch the console into it, then drop into inline-rename on its header.
 * Switching (not just marking it active) is the point: it unloads the previous session's tabs and
 * puts the start screen in the middle column, so a fresh session opens on its own choices - start a
 * chat, open a doc, work with an app - instead of leaving the old session's tabs on screen.
 * @returns {Promise<void>}
 */
async function newProject() {
  const { project } = await postJSON("/api/projects", { name: "New session" });
  await refreshProjects(); // so switchToProject can find the new project in S.projects
  await switchToProject(project.id);
  // inline-rename the fresh session - after the switch, whose own re-render would replace the input
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
 * Delete the chat behind `tab` from whichever session holds it (and close its tab). Called after the
 * confirmation in requestCloseTab - a chat is the session's content, so closing IS deleting.
 * @param {object} tab - the chat tab being closed ({id, sessionId}).
 * @returns {Promise<void>}
 */
async function deleteChatFromSession(tab) {
  // Search every session, not just the active one: a tab can outlive a session switch.
  for (const p of S.projects || []) {
    const idx = (p.items || []).findIndex((it) => it.type === "chat" && it.sessionId === tab.sessionId);
    if (idx >= 0) return removeProjectItem(p.id, idx, p.items[idx]); // closes the tab too
  }
  closeTab(tab.id); // not tracked in any session - nothing to delete, just close it
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
