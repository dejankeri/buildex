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
  [key: string]: unknown;
}
interface JsdomEl {
  textContent: string | null;
  innerHTML: string;
  className: string;
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
const bundle = scriptSrcs
  .filter((s) => s !== "js/main.js")
  .map((f) => readFileSync(join(WEB, f), "utf8"))
  .join("\n;\n");

// Every top-level binding, exposed so any console-render-*.test.ts can assert on any renderer without
// touching this shared harness. All names must be real top-level bindings of the bundle (an unknown
// name throws a ReferenceError when the shim evaluates - a useful early failure). Kept in sync with
// the modules by `grep -rhoE "^(async )?function [A-Za-z0-9_]+" web/js/*.js`.
const EXPOSE = [
  // shared state + micro-helpers (const/let) + the safe DOM builder (dom.js)
  "S", "tabSeq", "$", "$$", "elt", "ago", "esc", "escAttr", "md", "IS_MAC", "ADD_ACTIONS", "el", "txt", "frag",
  // function declarations (all of them)
  "activateTab", "addTab", "addToActiveProject", "agentTurn", "appConn", "boot", "brainNodes", "btime",
  "buildAppPane", "buildBrainSvg", "buildBrowserPane", "buildChatPane", "buildStorePane", "checkOnboarding",
  "closeMenus", "closeTab", "confirmPending", "connectApp", "ensureDefaultProject", "fillSyncLog",
  "findPendingCard", "flattenTree", "fmtNext", "fmtReset", "folderPaths", "getJSON", "hideProjectStart",
  "insertAt", "kbdLabel", "loadAgentView", "loadBrain", "loadDoc", "loadMap", "loadSession", "loadStorePane",
  "loadTree", "navGo", "navRecord", "navUpdate", "newConversation", "newProject", "offerConnect",
  "onAddShortcut", "openAddAppForm", "openAddMenu", "openAppTab", "openAttachPicker", "openAutomationEditor",
  "openBrainTab", "openBrowserTab", "openChatTab", "openConnectorEditor", "openDocTab", "openFilesSettings",
  "openFolderPicker", "openMapTab", "openMarkdownEditor", "openMcpEditor", "openProjectItem", "openSaveMenu",
  "openSkillEditor", "openSkillTab", "openStoreTab", "parseSkill", "pickTarget", "postJSON", "projectMenu",
  "refreshOrgs", "renderOrgSwitcher", "toggleOrgMenu", "switchOrg", "createOrg",
  "projectRename", "rApps", "rAuto", "rFiles", "rGateway", "rPending", "rSkills", "rSyncLog", "refreshApps",
  "refreshPending", "refreshProjects", "refreshUsage", "removeProjectItem", "renderAgentHealth", "renderBrain",
  "renderBrainRail", "renderConnectorEditor", "renderHistory", "renderMcpEditor", "renderPending",
  "renderTabbar", "renderTree", "reorderTab", "resolveCard", "runSkill", "sendPrompt", "setMsg", "setSync",
  "showProjectStart", "startApiKey", "clearApiKey", "startAppHost", "startBrainFlow", "startInstall", "startUninstall", "storeNotice",
  "stripFrontmatter", "switchRight", "switchToProject", "wireAppBridge", "wysiInline", "wysiToMd",
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
