"use strict";
// boot() — first paint: wires the title bar, loads config, restores projects.
//
// The app entry point for the operator console (web/index.html): it binds every title-bar and
// rail control, pulls the initial config, hydrates projects/apps/tree, opens the default right
// panel, and starts the background refresh loops.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// State it reads/writes on the shared global `S`: `S.config` (server config, fetched here) and
// `S.activeProject` (the project to restore into the tab strip on load).

/** Persist the current column-collapse state to localStorage (a per-profile local file Electron keeps
 *  under userData), so the layout is restored on the next launch. */
function savePanels() {
  const a = $(".app").classList;
  try { localStorage.setItem("buildex.panels", JSON.stringify({ lc: a.contains("lc"), rc: a.contains("rc") })); } catch (e) {}
}

/** Hide/show BOTH side panels together, Figma-style (Cmd/Ctrl+\). If either is open, collapse both;
 *  if both are already collapsed, reveal both. The choice is remembered for next launch. */
function togglePanels() {
  const cl = $(".app").classList;
  const anyOpen = !cl.contains("lc") || !cl.contains("rc");
  cl.toggle("lc", anyOpen);
  cl.toggle("rc", anyOpen);
  savePanels();
}

/**
 * First paint: bind the title-bar/rail controls, fetch config, load the initial data (projects,
 * apps, doc tree), open the default right panel, and kick off the background refresh loops.
 * @returns {Promise<void>} resolves once the initial load has been kicked off.
 */
async function boot() {
  // On the macOS desktop build we reserve room for the traffic lights and paint our own chrome
  // into the title-bar strip (see titleBarStyle:"hidden" in the Electron main process).
  if (/Mac/i.test(navigator.platform) && /Electron/i.test(navigator.userAgent)) document.body.classList.add("macapp");
  $("#themeBtn").onclick = () => {
    const c = document.documentElement.getAttribute("data-theme");
    // no explicit theme yet → follow the OS preference, then flip to the opposite.
    const dark = c ? c === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
  };
  // Column collapse is remembered across launches (localStorage - see savePanels below). On the VERY
  // first launch nothing is stored, so both columns start open (default applied after the initial
  // render); afterwards we honor the operator's choice.
  $("#tgLeft").onclick = () => { $(".app").classList.toggle("lc"); savePanels(); }; // toggle + remember the left column
  $("#tgRight").onclick = () => { $(".app").classList.toggle("rc"); savePanels(); }; // toggle + remember the right column
  $("#helpBtn").onclick = () => startTour(true); // replay the guided tour any time
  $("#brandBtn").onclick = () => openBrainTab();
  $("#navBack").onclick = () => navGo(-1);
  $("#navFwd").onclick = () => navGo(1);
  $("#newProject").onclick = () => newProject();
  $("#newSessionTop").onclick = () => newProject();
  $("#storeTop").onclick = () => openStoreTab();
  $("#appsEdit").onclick = () => toggleAppsEdit(); // drag-to-reorder the Apps & Tools rail
  try { S.appsExpanded = localStorage.getItem("buildex.appsExpanded") === "1"; } catch (e) {}
  $("#tabAdd").onclick = (e) => openAddMenu(e.currentTarget);
  document.addEventListener("keydown", onAddShortcut); // ⌘/Ctrl shortcuts for the ＋ add-menu
  $$("#rtabs button[data-r]").forEach((b) => b.onclick = () => switchRight(b.dataset.r));
  // The dot leads to whatever the operator most likely wants: no account yet - or an account that
  // needs reconnecting - means the action is to (re)connect; unsaved work lives in the pending tray;
  // otherwise the change log answers "what happened?".
  $("#sync").onclick = () => {
    const dot = $("#sync");
    if (dot.classList.contains("local") || dot.classList.contains("reconnect")) { openConnectAccount(); return; }
    // Unsaved work and "what synced?" both live in the brain map now (the Gate holds the save card's
    // sibling approvals; Learning is the change log) — the dot opens the map rather than a lone panel.
    switchRight("brain");
  };
  $("#usageRefresh").onclick = () => refreshUsage(true);
  try {
    S.config = await getJSON("/api/config");
  } catch (e) {}
  await refreshOrgs(); // org switcher (hides itself on a single-workspace daemon)
  await refreshProjects();
  await refreshApps();
  await loadTree();
  // Restore the scope lens + the persisted panel choice; the Brain map is the default right panel.
  try { S.brainScope = localStorage.getItem("buildex.brainScope") || "all"; } catch (e) {}
  switchRight("brain");
  // Restore the remembered column state; on the first-ever launch (nothing stored) leave BOTH columns
  // open so a new operator sees the whole workspace - left rail AND right panel - before collapsing.
  let panels = null;
  try { panels = JSON.parse(localStorage.getItem("buildex.panels") || "null"); } catch (e) {}
  $(".app").classList.toggle("lc", !!(panels && panels.lc));
  $(".app").classList.toggle("rc", !!(panels && panels.rc));
  refreshPending();
  startApprovals(); // open the live approval feed → inline Approve/Deny cards in the originating chat
  refreshUsage();
  startAppHost(); // fire-and-forget - loops forever for the page session
  setInterval(refreshProjects, 5000);
  setInterval(refreshApps, 8000);
  setInterval(refreshPending, 4000);
  setInterval(() => refreshUsage(), 15 * 60000);
  // load the active project's context (its tabs), or show the start screen if it's empty
  if (S.activeProject) switchToProject(S.activeProject);
  // First run: ask for the company name (and, when available, whether to back up to the cloud)
  // BEFORE the rest of the wizard. openOnboard() does NOT mark onboarding complete - it only tears
  // itself down - so /api/onboarding still reports firstRun:true afterward and checkOnboarding()
  // (called unconditionally below) runs its full step sequence, including the essential "Connect
  // your agent (Claude Code)" step. checkOnboarding() itself POSTs /api/onboarding/complete when
  // it finishes, so the marker is set exactly once, by the wizard.
  let firstRun = false;
  try {
    const o = await getJSON("/api/onboarding");
    firstRun = !!(o && o.firstRun);
  } catch (e) {}
  if (firstRun && typeof openOnboard === "function") await openOnboard();
  checkOnboarding(); // fire-and-forget - shows the first-run wizard once on a fresh install
}
