"use strict";
// Middle column: the tab bar, tab lifecycle (open/activate/close/reorder), and the title-bar
// back/forward navigation over focused tabs.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// State it owns/reads on the shared global `S`: `S.tabs` (open tabs), `S.active` (focused tab id),
// `S.hist`/`S.hp` (the focus-history stack + its cursor), `S.navLock` (suppresses history
// recording while replaying it).

/** Id of the tab currently being drag-reordered, or null when no drag is in flight. */
let dragTabId = null;

/**
 * Move tab `fromId` to the position of tab `toId` within `S.tabs`, then repaint the bar.
 * @param {string} fromId - id of the tab being moved.
 * @param {string} toId   - id of the tab it is dropped onto.
 * @param {boolean} after - true to drop after `toId` (right half), false to drop before it.
 */
function reorderTab(fromId, toId, after) {
  const from = S.tabs.findIndex((t) => t.id === fromId);
  if (from < 0) return;
  const [moved] = S.tabs.splice(from, 1);
  let to = S.tabs.findIndex((t) => t.id === toId);
  if (to < 0) {
    // target vanished mid-drag — put the tab back where it was and bail.
    S.tabs.splice(from, 0, moved);
    return;
  }
  if (after) to++;
  S.tabs.splice(to, 0, moved);
  renderTabbar();
}

/** Rebuild the tab bar from `S.tabs`, wiring click/close/middle-click and drag-to-reorder. */
function renderTabbar() {
  const bar = $("#tabbar");
  $$(".tab", bar).forEach((t) => t.remove());
  let activeEl = null;
  S.tabs.forEach((t) => {
    const el = elt("div", "tab" + (t.id === S.active ? " active" : ""));
    // chat tabs show a live status dot; every other surface shows a per-type glyph.
    const icon =
      t.type === "chat"
        ? '<span class="st ' + (t.status || "idle") + '"></span>'
        : '<span class="ti">' +
          ({ doc: "▤", browser: "◉", map: "◇", brain: "❋", skill: "✦", skilledit: "✎", mdedit: "✎", automation: "↻", mcp: "⚡", conn: "⇄", app: "◈", store: "◈" }[t.type] || "◈") +
          "</span>";
    el.innerHTML = icon + '<span class="tt">' + esc(t.title) + '</span><span class="x">×</span>';
    el.onclick = (e) => {
      if (e.target.classList.contains("x")) {
        requestCloseTab(t.id);
      } else activateTab(t.id);
    };
    el.onmousedown = (e) => {
      if (e.button === 1) e.preventDefault(); // suppress middle-click autoscroll
    };
    el.onauxclick = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        requestCloseTab(t.id); // middle-click closes the tab
      }
    };
    // --- drag to reorder ---
    el.draggable = true;
    el.ondragstart = (e) => {
      dragTabId = t.id;
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", t.id);
      } catch (_) {}
      el.classList.add("dragging");
    };
    el.ondragend = () => {
      dragTabId = null;
      $$(".tab", bar).forEach((x) => x.classList.remove("dragging", "dragover-l", "dragover-r"));
    };
    el.ondragover = (e) => {
      if (!dragTabId || dragTabId === t.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // highlight the half (left/right) the drop would land on.
      const r = el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      el.classList.toggle("dragover-r", after);
      el.classList.toggle("dragover-l", !after);
    };
    el.ondragleave = () => el.classList.remove("dragover-l", "dragover-r");
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove("dragover-l", "dragover-r");
      if (!dragTabId || dragTabId === t.id) return;
      const r = el.getBoundingClientRect();
      reorderTab(dragTabId, t.id, e.clientX > r.left + r.width / 2);
    };
    bar.appendChild(el);
    if (t.id === S.active) activeEl = el;
  });
  scrollTabIntoView(bar, activeEl);
}

/**
 * Keep the active tab on screen. Opening a tab when the strip is already full used to put it just
 * past the right edge - the operator asked for a thing and the app appeared to do nothing - and the
 * same happens on the left when a tab is activated from the sessions rail.
 * @param {Element} bar - the scrolling strip (#tabbar).
 * @param {Element|null} el - the active tab row, or null when nothing is active.
 */
function scrollTabIntoView(bar, el) {
  if (!bar || !el) return;
  // Measured against the strip itself, so the pinned ＋ (a sibling now) never counts as room.
  const left = el.offsetLeft - bar.offsetLeft;
  const right = left + el.offsetWidth;
  if (!bar.clientWidth) return; // not laid out yet (hidden pane, or jsdom) - nothing to scroll
  const pad = 8; // leave a sliver of the neighbouring tab visible, so "there is more" still reads
  if (left - pad < bar.scrollLeft) bar.scrollLeft = Math.max(0, left - pad);
  else if (right + pad > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right + pad - bar.clientWidth;
}

/** Focus tab `id`: show its pane, hide the rest, repaint the bar, record it in nav history. */
function activateTab(id) {
  S.active = id;
  S.tabs.forEach((t) => t.pane.classList.toggle("on", t.id === id));
  renderTabbar();
  refreshProjects();
  navRecord(id);
}

// --- title-bar back/forward: a visited-history of focused tabs; closed tabs are skipped over. ---

/** Push `id` onto the focus-history stack (unless we're replaying history, or it's already on top). */
function navRecord(id) {
  if (S.navLock || id == null) return;
  if (S.hist[S.hp] === id) {
    navUpdate();
    return;
  }
  S.hist = S.hist.slice(0, S.hp + 1); // drop any forward history — a new focus forks the timeline.
  S.hist.push(id);
  S.hp = S.hist.length - 1;
  navUpdate();
}

/**
 * Step back (`dir === -1`) or forward (`dir === 1`) through focus history, skipping tabs that have
 * since been closed, and activate the first still-open one found.
 */
function navGo(dir) {
  let np = S.hp;
  while (true) {
    np += dir;
    if (np < 0 || np >= S.hist.length) {
      navUpdate();
      return;
    }
    const id = S.hist[np];
    if (S.tabs.find((t) => t.id === id)) {
      S.hp = np;
      S.navLock = true; // don't re-record this focus as a new history entry.
      activateTab(id);
      S.navLock = false;
      navUpdate();
      return;
    }
  }
}

/** Enable/disable the back/forward buttons based on whether any open tab remains in each direction. */
function navUpdate() {
  const b = $("#navBack"),
    f = $("#navFwd");
  if (!b || !f) return;
  b.disabled = !S.hist.slice(0, S.hp).some((id) => S.tabs.find((t) => t.id === id));
  f.disabled = !S.hist.slice(S.hp + 1).some((id) => S.tabs.find((t) => t.id === id));
}

/**
 * Close a tab *from the tab bar*. A chat is the session's content - the left rail lists exactly the
 * chats - so closing one is deleting it, and it asks first. Every other surface (doc, browser, map,
 * store…) is only a view of something that lives elsewhere, so it closes with no ceremony.
 * @param {string} id - tab id.
 */
function requestCloseTab(id) {
  const t = S.tabs.find((x) => x.id === id);
  if (!t || t.type !== "chat") return closeTab(id);
  confirmAction({
    title: "Delete this chat?",
    body: "“" + (t.title || "Chat") + "” and its history are removed from this session. Documents and browsers you opened stay where they are.",
    confirm: "Delete chat",
    onConfirm: () => deleteChatFromSession(t),
  });
}

/** Close tab `id`: dispose it, remove its pane, and focus a neighbour (or the start screen if none). */
function closeTab(id) {
  const i = S.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  // A closed tab leaves the session too - otherwise switching away and back reopens everything the
  // operator just dismissed. (itemRemoved: the caller already took the item out.)
  if (!S.tabs[i].itemRemoved) forgetTabFromSession(S.tabs[i]);
  if (S.tabs[i].dispose)
    try {
      S.tabs[i].dispose(); // let the pane tear down listeners/intervals/webviews.
    } catch (e) {}
  S.tabs[i].pane.remove();
  S.tabs.splice(i, 1);
  if (S.active === id) S.active = S.tabs.length ? S.tabs[Math.max(0, i - 1)].id : null;
  if (S.active) activateTab(S.active);
  else {
    renderTabbar();
    showProjectStart();
  }
  navUpdate();
}

/** Append a new tab: assign it an id, mount an empty pane, register it, and focus it. */
function addTab(tab) {
  hideProjectStart();
  tab.id = "t" + (++tabSeq);
  tab.pane = elt("div", "pane");
  $("#tabbody").appendChild(tab.pane);
  S.tabs.push(tab);
  activateTab(tab.id);
  return tab;
}

/**
 * Open (or re-focus) a chat tab for session `sess`, building its pane and loading its history.
 * @param {object} sess - the session ({id, title, status}).
 * @param {object} [app] - the app this chat belongs to, when it was started from one; carried on the
 *   tab so the app's mark and connect banner survive a session reload.
 */
function openChatTab(sess, app) {
  const existing = S.tabs.find((t) => t.type === "chat" && t.sessionId === sess.id);
  if (existing) {
    activateTab(existing.id);
    return;
  }
  const tab = addTab({ type: "chat", title: sess.title || "Chat", sessionId: sess.id, status: sess.status || "idle", app: app || null, appConn: app && typeof appConn === "function" ? appConn(app.name) : null });
  buildChatPane(tab);
  loadSession(tab);
}

/** Open (or re-focus) a read-only document tab for `path`; optionally add it to the active project. */
function openDocTab(path, join) {
  const existing = S.tabs.find((t) => t.type === "doc" && t.path === path);
  if (existing) {
    activateTab(existing.id);
    return;
  }
  const tab = addTab({ type: "doc", title: path.split("/").pop(), path });
  tab.pane.className = "pane docpane on";
  tab.pane.innerHTML = "loading…";
  loadDoc(tab);
  if (join !== false) addToActiveProject({ type: "doc", path });
}

/** Open an in-app browser tab at `url` (defaults to blank); optionally add it to the active project. */
function openBrowserTab(url, join) {
  const tab = addTab({ type: "browser", title: "Browser", url: url || "about:blank" });
  buildBrowserPane(tab);
  if (join !== false) addToActiveProject({ type: "browser", url: url || "about:blank" });
}

/** Open (or re-focus) the single repo-map tab; optionally add it to the active project. */
function openMapTab(join) {
  const ex = S.tabs.find((t) => t.type === "map");
  if (ex) {
    activateTab(ex.id);
    return;
  }
  const tab = addTab({ type: "map", title: "Map" });
  tab.pane.className = "pane mappane on";
  loadMap(tab);
  if (join !== false) addToActiveProject({ type: "map" });
}
