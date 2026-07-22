// Shared jsdom harness for the operator-console browser test net. It loads the REAL
// console bundle - md.js + the ordered js/* classic-script modules, minus main.js's boot() call -
// into a fresh jsdom window so renderer tests can assert real DOM output (and, above all, that
// operator/agent-supplied text is ESCAPED not injected). Not a .test.ts, so vitest never collects it
// as a suite; it's imported by the console-render*.test.ts files.
//
// Why the shim: the modules are "use strict", so under an indirect eval their top-level
// function/const bindings do NOT leak onto the window. We capture the ones tests assert on by NAME in
// a shim appended to the SAME program (esc/escAttr/md are already put on globalThis by md.js itself).
//
// Why a local ambient declaration (jsdom-shim.d.ts) instead of @types/jsdom: @types/jsdom
// triple-references lib="dom", which would pull the browser DOM globals into this Node/Electron
// project and make the daemon's Node `Response`/`Buffer` usage stop type-checking. We keep the
// daemon's Node type environment clean and type the jsdom surface loosely here (the DOM is exercised
// at runtime, not at compile time).

/** The bits of a jsdom window this harness and its tests touch. Loosely typed on purpose. */
interface JsdomWindow {
  document: JsdomDoc;
  eval(code: string): unknown;
  [key: string]: unknown;
}
/** A minimal DOM query surface (jsdom provides the real thing at runtime). */
interface JsdomDoc {
  querySelector(sel: string): JsdomEl | null;
  querySelectorAll(sel: string): ArrayLike<JsdomEl>;
  /** Tests that build their own nodes (a chat thread, a scroll container) need this typed; the
   *  index signature alone would leave it `unknown`. */
  createElement(tag: string): JsdomEl;
  /** The window, for constructing real Event/KeyboardEvent instances to dispatch. */
  defaultView: JsdomWindow;
  [key: string]: unknown;
}
interface JsdomEl {
  textContent: string | null;
  innerHTML: string;
  className: string;
  /** Live child-element list — how the streaming tests assert that unchanged blocks were reused. */
  children: ArrayLike<JsdomEl>;
  /** data-* attributes (e.g. the code-block "already wrapped" marker). */
  dataset: Record<string, string | undefined>;
  getAttribute(name: string): string | null;
  querySelector(sel: string): JsdomEl | null;
  querySelectorAll(sel: string): ArrayLike<JsdomEl>;
  click(): void;
  [key: string]: unknown;
}

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const html = readFileSync(join(WEB, "index.html"), "utf8");
const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]!);
// vendor/ is excluded on purpose: it is ~130KB of minified grammar tables that every call site
// already guards on (`typeof hljs`), so loading it would only cost every renderer test a parse of
// third-party code that changes none of the DOM these tests assert on. Running without it is also
// the honest check that the guards hold.
const bundle = scriptSrcs
  .filter((s) => s !== "js/main.js" && !s.startsWith("vendor/"))
  .map((f) => readFileSync(join(WEB, f), "utf8"))
  .join("\n;\n");

// Every top-level binding, exposed so any console-render-*.test.ts can assert on any renderer without
// touching this shared harness. All names must be real top-level bindings of the bundle (an unknown
// name throws a ReferenceError when the shim evaluates - a useful early failure). Kept in sync with
// the modules by `grep -rhoE "^(async )?function [A-Za-z0-9_]+" web/js/*.js`.
const EXPOSE = [
  // shared state + micro-helpers (const/let) + the safe DOM builder (dom.js)
  "S", "tabSeq", "$", "$$", "elt", "ago", "esc", "escAttr", "md", "mdBlocks", "IS_MAC", "ADD_ACTIONS", "el", "txt", "frag",
  "SLASH_COMMANDS", "REATTACH_POLL_MS", "APPS_VISIBLE",
  // function declarations (all of them)
  "activateTab", "addTab", "addToActiveProject", "agentTurn", "appConn", "boot", "brainNodes", "btime",
  "buildAppPane", "buildBrainSvg", "buildBrowserPane", "buildChatPane", "buildComposer", "buildStorePane",
  "chatTitle", "checkOnboarding", "clockTime", "copyText", "editAndResend", "enhanceCode", "flashLabel",
  "follower", "mdInto", "reattach", "repoRelative", "retryLast", "stopTurn", "userTurn",
  "closeMenus", "closeTab", "requestCloseTab", "confirmAction", "deleteChatFromSession", "confirmPending", "connectApp", "ensureDefaultProject", "fillSyncLog",
  "findPendingCard", "flattenTree", "fmtNext", "fmtReset", "getJSON", "hideProjectStart",
  "injectApproval", "kbdLabel", "loadAgentView", "loadBrain", "loadDoc", "loadMap", "loadSession", "loadStorePane",
  "loadTree", "navGo", "navRecord", "navUpdate", "newConversation", "newProject", "offerConnect",
  "onAddShortcut", "openAddAppForm", "openAddMenu", "openAppTab", "openAutomationEditor", "openConnectAccount",
  "openBrainTab", "openBrowserTab", "openChatTab", "openConnectorEditor", "openDocTab", "openFilesSettings",
  "openMapTab", "openMarkdownEditor", "openMcpEditor", "openOnboard", "openProjectItem", "openSaveMenu", "openSaveDialog", "locationLabel",
  "openSkillEditor", "openSkillTab", "openStoreTab", "parseSkill", "postJSON", "projectMenu",
  "refreshOrgs", "renderOrgSwitcher", "toggleOrgMenu", "switchOrg", "createOrg",
  "projectRename", "projectStatus", "rAuto", "rFiles", "rGateway", "rPending", "rSkills", "rSyncLog", "refreshApps",
  "refreshPending", "refreshProjects", "refreshUsage", "removeProjectItem", "renderAgentHealth", "rootSlot", "toggleTreeNode", "treeActions", "wireTreeActions", "openFileMenu", "openTreeMoreMenu", "uploadIntoFolder", "fsDo", "promptAction", "toast", "renderBrain",
  "renderBrainRail", "renderConnectorEditor", "renderHistory", "renderMcpEditor", "renderPending", "renderSigninPill",
  "renderTabbar", "renderTree", "reorderTab", "resolveCard", "runSkill", "scrollTabIntoView", "sendPrompt", "setMsg", "setSync",
  "showProjectStart", "startApiKey", "clearApiKey", "startAppHost", "startBrainFlow", "startInstall", "startSignIn", "startUninstall", "storeNotice",
  // Apps & Tools rail: manual order, the visible cap, edit mode, and the chat-side connect gate.
  "appOrderKey", "savedAppOrder", "saveAppOrder", "orderApps", "renderApps", "appRow", "wireAppDrag", "toggleAppsEdit",
  "openAppChat", "openConnectDialog", "appConnectRoutes", "connectAppApi",
  "appGateActive", "renderAppGate", "clearAppGate", "syncAppConn", "renderCtxChip",
  "appGlyph", "mountAppLogo", "openAppSettings", "appSettingsBody",
  "stripFrontmatter", "switchRight", "switchToProject", "syncDotState", "wireAppBridge", "wysiInline", "wysiToMd",
];
const SHIM = ";globalThis.__c = { " + EXPOSE.join(", ") + " };";

export interface ConsoleHandle {
  /** The jsdom window (globalThis of the loaded bundle). */
  w: JsdomWindow;
  /** The jsdom document the renderers manipulate. */
  doc: JsdomDoc;
  /** The exposed console bindings (see EXPOSE): `c.S`, `c.renderPending`, etc. Typed as `any` because
   *  the values are the real renderer functions + the shared state object from dynamic JS. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Record<string, any>;
}

/** Load the real console bundle into a fresh jsdom and return handles for assertions. Each call is a
 *  clean window (no shared state between tests). */
export function loadConsole(): ConsoleHandle {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://127.0.0.1/", pretendToBeVisual: true });
  const w: JsdomWindow = dom.window;
  // jsdom has no matchMedia; renderer tests never hit the network (we call renderers directly).
  w["matchMedia"] = () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} });
  w["fetch"] = () => Promise.reject(new Error("no network in renderer tests"));
  w.eval(bundle + SHIM);
  return { w, doc: w.document, c: w["__c"] as ConsoleHandle["c"] };
}
