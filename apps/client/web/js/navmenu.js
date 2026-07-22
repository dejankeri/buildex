"use strict";
// Project-item open/switch, empty-project start screen, the ＋ add-menu.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// State it reads/writes on the shared global `S`: `S.projects` (project list + their saved items),
// `S.activeProject` (id of the open project), `S.tabs`/`S.active` (open tabs + focused tab id),
// `S.apps` (installed apps, resolved when re-opening an "app" item).

/**
 * Open a single saved project item by dispatching on its type to the matching tab opener.
 * @param {object} it - a persisted project item ({type, plus type-specific fields}).
 */
function openProjectItem(it) {
  // A chat started from an app carries its id; resolve it back to the installed app so the reopened
  // tab keeps the app's mark and its connect banner (unresolvable id -> a plain chat, never a crash).
  if (it.type === "chat") openChatTab({ id: it.sessionId, title: it.title || "Chat", status: "idle" }, it.app ? (S.apps || []).find((x) => x.name === it.app) : null);
  else if (it.type === "doc") openDocTab(it.path, false);
  else if (it.type === "browser") openBrowserTab(it.url, false);
  else if (it.type === "map") openMapTab(false);
  else if (it.type === "app") {
    const a = (S.apps || []).find((x) => x.repo === it.repo && x.name === it.name);
    if (a) openAppTab(a, false);
  }
}

/**
 * Switch the console to project `pid`: tear down the current project's tabs, open the new one's
 * saved items, and focus a tab (or show the start screen when the project is empty).
 * @param {string} pid - id of the project to activate.
 * @param {number} [focusIdx] - index into the freshly-opened tabs to focus; defaults to the last.
 */
async function switchToProject(pid, focusIdx) {
  S.activeProject = pid;
  // unload the previous project's tabs
  S.tabs.slice().forEach((t) => {
    if (t.dispose)
      try {
        t.dispose();
      } catch (e) {}
    t.pane.remove();
  });
  S.tabs = [];
  S.active = null;
  const p = (S.projects || []).find((x) => x.id === pid);
  if (p) p.items.forEach(openProjectItem); // load this project's context
  if (typeof focusIdx === "number" && S.tabs[focusIdx]) activateTab(S.tabs[focusIdx].id);
  else if (S.tabs.length) activateTab(S.tabs[S.tabs.length - 1].id);
  if (!S.tabs.length) {
    renderTabbar();
    showProjectStart();
  }
  // Awaited so a caller that touches the freshly-painted rail (newProject's inline rename) isn't
  // racing a re-render that would replace the row it just grabbed.
  await refreshProjects();
}

/** Render the empty-project start screen into the tab body: the two primitives (chat + document),
 *  then a "work with your apps & tools" section - each installed app opens an AI chat focused on it,
 *  and an always-present CTA opens the Store to add more (the on-ramp for a new operator). */
function showProjectStart() {
  hideProjectStart();
  const p = (S.projects || []).find((x) => x.id === S.activeProject);
  const apps = S.apps || [];
  // One launcher per installed app: clicking it starts an AI chat oriented to that app's tools.
  const appBtns = apps.map((a) => '<button class="ss-tool" data-app="' + escAttr(a.name) + '"><span class="ss-ic">' + appGlyph(a) + "</span>" + esc(a.title) + "</button>").join("");
  const el = elt("div", "startscreen");
  el.id = "startScreen";
  el.innerHTML = '<div class="ss-card"><div class="ss-emoji">✦</div><h2>' + esc((p && p.name) || "Session") + "</h2>"
    + "<p>Start working - everything you open stays in this session.</p>"
    + '<div class="ss-actions"><button data-a="chat"><span>◈</span>Start a chat</button><button data-a="doc"><span>✎</span>New document</button></div>'
    + '<div class="ss-tools"><div class="ss-tools-h">Work with your apps &amp; tools</div>'
    + '<div class="ss-tools-row">' + appBtns
    + '<button class="ss-store" data-a="store"><span>⊕</span>' + (apps.length ? "Add apps &amp; tools" : "Add apps &amp; tools you work with") + "</button></div></div>"
    + '<div class="ss-tips"></div>'
    + "</div>";
  $("#tabbody").appendChild(el);
  el.querySelectorAll("[data-a]").forEach((b) => b.onclick = () => {
    const a = b.dataset.a;
    if (a === "chat") newConversation();
    else if (a === "doc") openMarkdownEditor(null, "");
    else if (a === "store") openStoreTab();
  });
  el.querySelectorAll("[data-app]").forEach((b) => b.onclick = () => {
    const app = (S.apps || []).find((x) => x.name === b.dataset.app);
    if (app) openAppChat(app);
  });
  // Rotating shortcut tips: 2 random ones, reshuffled every few seconds while this screen is up.
  const tips = $(".ss-tips", el);
  if (tips) {
    renderShortcutTips(tips);
    if (_tipTimer) clearInterval(_tipTimer);
    _tipTimer = setInterval(() => {
      if (document.body.contains(tips)) renderShortcutTips(tips);
      else { clearInterval(_tipTimer); _tipTimer = null; }
    }, 5000);
  }
}

/** Remove the start screen from the DOM if it is currently shown (and stop the tip rotation). */
function hideProjectStart() {
  if (_tipTimer) { clearInterval(_tipTimer); _tipTimer = null; }
  const el = $("#startScreen");
  if (el) el.remove();
}

// One source of truth for the "＋" add-menu: the popup and the global keyboard shortcuts share it.
// Modifier is ⌘ on macOS, Ctrl elsewhere; the letter+shift combo is identical across platforms.
const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent || "");

// Keyboard shortcuts surfaced as rotating discovery tips on the empty session screen. `keys` render as
// <kbd> chips ("mod" → ⌘ on macOS, Ctrl elsewhere).
const SHORTCUT_TIPS = [
  { label: "New chat", keys: ["mod", "N"] },
  { label: "New document", keys: ["mod", "⇧", "N"] },
  { label: "Open a document", keys: ["mod", "O"] },
  { label: "Web browser", keys: ["mod", "⇧", "B"] },
  { label: "Hide / show panels", keys: ["mod", "\\"] },
  { label: "Next session", keys: ["mod", "⇧", "]"] },
  { label: "Previous session", keys: ["mod", "⇧", "["] },
];
let _tipTimer = null; // rotation interval for the tips, cleared when the start screen goes away

/** Paint TWO random shortcut tips into `host` (kbd chips + label). Re-called on a timer so the pair
 *  keeps changing - lightweight discovery, especially useful before the operator has many apps. */
function renderShortcutTips(host) {
  const pool = SHORTCUT_TIPS.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  host.innerHTML = pool.slice(0, 2).map((t) =>
    '<span class="ss-tip">' + t.keys.map((k) => "<kbd>" + esc(k === "mod" ? (IS_MAC ? "⌘" : "Ctrl") : k) + "</kbd>").join("") + '<span class="ss-tip-l">' + esc(t.label) + "</span></span>"
  ).join("");
}

/**
 * Build the human-readable shortcut label for an add-action.
 * @param {boolean} shift - whether the shortcut requires Shift.
 * @param {string} letter - the shortcut letter (already upper-cased for display).
 * @returns {string} e.g. "⌘⇧N" on macOS, "Ctrl+Shift+N" elsewhere.
 */
function kbdLabel(shift, letter) {
  return IS_MAC ? ("⌘" + (shift ? "⇧" : "") + letter) : ("Ctrl+" + (shift ? "Shift+" : "") + letter);
}

// The add-menu items: icon glyph, label, keyboard shortcut (letter + shift flag), and the action.
// `menu:false` keeps an action on the keyboard but off the ＋ menu - "Open a document" is a jump to
// the Files rail, not a thing you START, so it doesn't belong in a menu of new things.
const ADD_ACTIONS=[
  {icon:"◈",label:"New chat",       key:"n",shift:false,run:()=>newConversation()},
  {icon:"✎",label:"New document",   key:"n",shift:true, run:()=>openMarkdownEditor(null,"")},
  {icon:"▤",label:"Open a document",key:"o",shift:false,menu:false,run:()=>switchRight("files")},
  {icon:"◉",label:"Web browser",    key:"b",shift:true, run:()=>openBrowserTab()},
];

/**
 * Global keydown handler: if the event matches an add-action shortcut, run it.
 * @param {KeyboardEvent} e - the keydown event.
 */
function onAddShortcut(e) {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return;
  // Hide/show both side panels together - Cmd/Ctrl+\ (Figma's "hide UI" trick). Match by code so it
  // works regardless of keyboard layout.
  if (!e.shiftKey && (e.code === "Backslash" || e.key === "\\")) { e.preventDefault(); togglePanels(); return; }
  // Switch sessions - Cmd/Ctrl+Shift+] (next) / [ (prev). Matched by code because Shift turns the
  // bracket keys into { } on most layouts.
  if (e.shiftKey && e.code === "BracketRight") { e.preventDefault(); switchSession(1); return; }
  if (e.shiftKey && e.code === "BracketLeft") { e.preventDefault(); switchSession(-1); return; }
  const k = (e.key || "").toLowerCase();
  const a = ADD_ACTIONS.find((x) => x.key === k && (!!x.shift === e.shiftKey));
  if (a) {
    e.preventDefault();
    closeMenus();
    a.run();
  }
}

/** Cycle the active session (project) by `dir` (+1 next / -1 previous), wrapping around. No-op with
 *  fewer than two sessions. */
function switchSession(dir) {
  const list = S.projects || [];
  if (list.length < 2) return;
  const cur = list.findIndex((p) => p.id === S.activeProject);
  const next = (((cur < 0 ? 0 : cur) + dir) % list.length + list.length) % list.length;
  if (list[next] && list[next].id !== S.activeProject) switchToProject(list[next].id);
}

/**
 * Open the "＋" add-menu dropdown anchored under `anchor`: the primitives you can start (chat, doc,
 * browser) and then every installed app, because "work with an app" is the main use case and was
 * only reachable from the empty-session screen. Both ＋ buttons - the tab bar's and a session
 * header's - open this same menu, so the answer to "what can I start?" is one list, not two.
 * @param {HTMLElement} anchor - the ＋ button the menu hangs off.
 * @param {string} [pid] - session to start the new thing in; switched to first when given.
 */
function openAddMenu(anchor, pid) {
  closeMenus();
  const m = elt("div", "dropdown addmenu");
  // A ＋ on a session header must act ON that session - switch first, then run, so a chat started
  // from a row the operator is pointing at never lands in whatever session was active before.
  const run = async (fn) => {
    closeMenus();
    if (pid && pid !== S.activeProject) await switchToProject(pid);
    fn();
  };
  ADD_ACTIONS.filter((a) => a.menu !== false).forEach((a) => {
    const b = elt("button", null, '<span class="k">' + a.icon + '</span>' + esc(a.label) + '<span class="kbd">' + kbdLabel(a.shift, a.key.toUpperCase()) + '</span>');
    b.onclick = () => run(a.run);
    m.appendChild(b);
  });
  const apps = S.apps || [];
  m.appendChild(elt("div", "mhd", apps.length ? "Apps &amp; tools" : "Apps &amp; tools - none yet"));
  apps.forEach((a) => {
    const b = elt("button", "amenu", '<span class="k">' + appGlyph(a) + "</span>" + esc(a.title || a.name));
    mountAppLogo($(".k", b), a.name, "mlogo");
    b.onclick = () => run(() => openAppChat(a));
    m.appendChild(b);
  });
  const store = elt("button", null, '<span class="k">⊕</span>Add apps &amp; tools');
  store.onclick = () => run(() => openStoreTab());
  m.appendChild(store);
  // Pinned to the anchor's viewport position: a session header sits inside an overflow:auto rail,
  // where an absolutely-positioned menu would be clipped (same reason projectMenu does this).
  document.body.appendChild(m);
  m.dataset.menu = "1";
  const r = anchor.getBoundingClientRect();
  m.style.position = "fixed";
  m.style.top = Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8) + "px";
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
}

/** Remove every open dropdown menu, and hide the file menu if present. */
function closeMenus() {
  $$('[data-menu]').forEach((m) => m.remove());
  const fm = $("#fileMenu");
  if (fm) fm.style.display = "none";
}

// Click anywhere outside a menu (or its trigger buttons) closes all open menus.
document.addEventListener("click", (e) => {
  if (!e.target.closest("[data-menu],#tabAdd,#fileMenuBtn,#fileMenu")) closeMenus();
});
