// Electron main process — a thin shell over the separable daemon core. It boots the demo
// daemon (which drives the operator's real `claude` CLI against the local workspace), waits for it
// to be reachable on loopback, then opens a native window onto it. All product logic lives in the
// daemon; this file is only window + lifecycle plumbing.
"use strict";

const { app, BrowserWindow, shell, session } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { isExternalUrl, sanitizeWebviewSrc } = require("./external-url.cjs");

// The dedicated session partition every external <webview> uses (see web/js/apps.js, browser.js).
// Isolating third-party content here keeps its cookies/permissions off the loopback console's own
// default session, and lets us lock down that session without touching the app itself.
const EXTERNAL_PARTITION = "persist:external-apps";

// Dev boots the tsx demo daemon on the fixed loopback port (4317); the packaged app boots the bundled
// daemon IN-PROCESS (org mode) on a dynamic port. `daemonUrl` is set once the daemon is reachable, and
// every window/navigation check resolves against it.
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
let daemon = null; // dev: the child tsx process; packaged: the in-process RunningDaemon (has close())
let daemonUrl = null; // set by bootDaemon() once the daemon is bound

// App identity: the name shown in the macOS menu bar / app switcher, and the dock/taskbar icon.
// (Full OS-level branding — installer, bundle id — comes later with the packaging config.)
app.setName("BuildEx");
const ICON_PNG = path.join(__dirname, "assets", "icon.png");

// Boot the daemon and resolve daemonUrl. Packaged: require the bundled build/daemon.cjs (a sibling of
// electron/ under the app root) and start the multi-org daemon IN-PROCESS - so asar-packed web assets
// and the bundled pack are read through Electron's fs, and the org registry lives in the app's userData
// dir. Dev: spawn the tsx demo daemon on the fixed BUILDEX_DEMO_PORT exactly as before, then await healthz.
async function bootDaemon() {
  if (app.isPackaged) {
    const { startPackagedDaemon } = require(path.join(__dirname, "..", "build", "daemon.cjs"));
    daemon = await startPackagedDaemon({ resourcesPath: process.resourcesPath, appDataDir: app.getPath("userData") });
    daemonUrl = daemon.url;
    return;
  }
  const PORT = process.env.BUILDEX_DEMO_PORT || "4317";
  daemonUrl = `http://127.0.0.1:${PORT}`;
  // On Windows the npm shims are .cmd files. Modern Node refuses to spawn a .cmd/.bat directly
  // (EINVAL, per CVE-2024-27980) unless shell:true, so route through the shell there; macOS/Linux
  // keep the plain spawn. This lets the dev daemon boot the same as on macOS.
  const isWin = process.platform === "win32";
  daemon = spawn(isWin ? "npx.cmd" : "npx", ["tsx", "scripts/demo.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, BUILDEX_DEMO_PORT: PORT },
    stdio: "inherit",
    shell: isWin,
  });
  daemon.on("error", (e) => console.error("failed to start daemon:", e.message));
  await new Promise((resolve) => waitForDaemon(daemonUrl, () => resolve()));
}

function waitForDaemon(url, cb, tries = 80) {
  const req = http.get(`${url}/healthz`, (res) => {
    res.resume();
    cb();
  });
  req.on("error", () => {
    if (tries <= 0) return cb(new Error("the daemon did not become ready"));
    setTimeout(() => waitForDaemon(url, cb, tries - 1), 500);
  });
}

function createWindow() {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "BuildEx",
    icon: ICON_PNG, // dock/taskbar icon on Windows/Linux; macOS uses app.dock.setIcon below
    backgroundColor: "#0c1413",
    // Unified title bar: hide the native title bar and let our own top strip fill the
    // space, keeping the macOS traffic lights (close/minimize/zoom) floating over it. The web UI
    // reserves room for them and paints its own chrome (toggles, tabs, nav) into that strip. On
    // non-mac we keep the default frame so the OS window controls remain available.
    titleBarStyle: isMac ? "hidden" : "default",
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    // webviewTag lets the in-app "Web browser" tab load real sites (a <webview> is a full browsing
    // context, so it isn't blocked by X-Frame-Options the way an <iframe> is).
    webPreferences: { contextIsolation: true, nodeIntegration: false, webviewTag: true },
  });

  // Route external links (an OAuth provider's authorize page, the marketing site) to the operator's
  // real browser instead of a chromeless in-app window — this is item 3: the authorize link now opens
  // the OS browser when running as the desktop app. Applies only to the main window's own content; the
  // in-app "Web browser" tab (<webview>) has its own webContents and keeps browsing in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url, daemonUrl)) shell.openExternal(url);
    return { action: "deny" }; // never spawn a bare popup window
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isExternalUrl(url, daemonUrl)) {
      event.preventDefault(); // keep the app on its loopback origin; send the link out to the browser
      shell.openExternal(url);
    }
  });

  // --- Harden the <webview> guests (external-app tabs + the in-app browser), the least-trusted
  //     surface in the app. Trust model: an embedded site is a FOREIGN browser tab, never part of
  //     BuildEx - no Node, no app preload, no local schemes, no hardware/location, and any popup
  //     leaves for the operator's real browser. See docs/trust-model-webview.md. ---

  // (1) Lock each guest's webPreferences before it loads: strip any page-supplied preload, force
  //     Node off + context isolation on, and refuse any non-http(s) src (file://, chrome://, …).
  win.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    params.src = sanitizeWebviewSrc(params.src);
  });

  // (2) Route any popup / window.open from a guest to the operator's real browser - never a
  //     chromeless in-app window. (Guests carry `allowpopups` so OAuth popups still work: they open
  //     outside the app, where the operator can see the real URL bar.)
  win.webContents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
  });

  win.loadURL(daemonUrl);
}

// (3) Deny EVERY permission request (camera, mic, geolocation, notifications, MIDI, …) for external
//     embedded content. Scoped to the external partition so the loopback console's own session is
//     untouched. An embedded page can never prompt for hardware or location inside BuildEx.
function lockExternalSession() {
  const ext = session.fromPartition(EXTERNAL_PARTITION);
  ext.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ext.setPermissionCheckHandler(() => false);
}

// Single instance: the daemon binds a fixed loopback port and owns the workspace, so a second launch
// would collide on the port and race the first on the same files (skill re-link, sync). Refuse the
// second instance and focus the running window instead. Without this, the installer's post-install
// launch plus a manual launch = two daemons racing, which can leave the workspace half-provisioned.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return; // a second instance is quitting; never boot a daemon
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(ICON_PNG);
  lockExternalSession(); // deny hardware/location permissions to embedded external content
  try {
    await bootDaemon();
  } catch (e) {
    console.error("the daemon did not become ready:", e.message);
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function stopDaemon() {
  if (!daemon) return;
  // packaged: RunningDaemon.close() (async, best-effort); dev: kill the child tsx process.
  if (typeof daemon.close === "function") daemon.close().catch(() => {});
  else if (typeof daemon.kill === "function") daemon.kill();
  daemon = null;
}
app.on("window-all-closed", () => {
  stopDaemon();
  if (process.platform !== "darwin") app.quit();
});
app.on("quit", stopDaemon);
