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
  $("#tgLeft").onclick = () => $(".app").classList.toggle("lc"); // toggle the left column collapse
  $("#tgRight").onclick = () => $(".app").classList.toggle("rc"); // toggle the right column collapse
  $("#brandBtn").onclick = () => openBrainTab();
  $("#navBack").onclick = () => navGo(-1);
  $("#navFwd").onclick = () => navGo(1);
  $("#newProject").onclick = () => newProject();
  $("#newSessionTop").onclick = () => newProject();
  $("#newAppTop").onclick = () => openAddAppForm();
  $("#tabAdd").onclick = (e) => openAddMenu(e.currentTarget);
  document.addEventListener("keydown", onAddShortcut); // ⌘/Ctrl shortcuts for the ＋ add-menu
  $$("#rtabs button[data-r]").forEach((b) => b.onclick = () => switchRight(b.dataset.r));
  $("#sync").onclick = () => switchRight("synclog");
  $("#usageRefresh").onclick = () => refreshUsage(true);
  try {
    S.config = await getJSON("/api/config");
  } catch (e) {}
  await refreshOrgs(); // org switcher (hides itself on a single-workspace daemon)
  await refreshProjects();
  await refreshApps();
  await loadTree();
  switchRight("pending");
  $(".app").classList.add("rc"); /* Pending is the default tab; panel starts collapsed */
  refreshPending();
  refreshUsage();
  startAppHost(); // fire-and-forget - loops forever for the page session
  setInterval(refreshProjects, 5000);
  setInterval(refreshApps, 8000);
  setInterval(refreshPending, 4000);
  setInterval(() => refreshUsage(), 15 * 60000);
  // load the active project's context (its tabs), or show the start screen if it's empty
  if (S.activeProject) switchToProject(S.activeProject);
  checkOnboarding(); // fire-and-forget - shows the first-run wizard once on a fresh install
}
