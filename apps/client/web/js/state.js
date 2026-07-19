"use strict";
// The single shared UI state object S + tab sequence counter.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// `S` is the one mutable global every other console module reads and writes; it is created here so
// it exists before any of them load. No server state lives here — it mirrors what the panes render.

/**
 * The shared console state. Fields:
 *  - config          : bootstrap config from the daemon (company info + repo roots).
 *  - roots           : configured repo roots (nested under config).
 *  - tabs            : open middle-column tabs.
 *  - active          : id of the focused tab, or null.
 *  - rightTab        : which right-panel view is showing ("files", "pending", "synclog", …).
 *  - tree/treeFilter : the file tree and its current filter string.
 *  - projects        : left-rail projects (task containers).
 *  - activeProject   : id of the selected project, or null.
 *  - apps            : installed apps/skills catalogue.
 *  - hist/hp         : title-bar back/forward focus-history stack and its cursor.
 *  - navLock         : true while replaying history, to suppress re-recording the focus.
 *  - showAgentFiles  : persisted toggle for showing agent-managed files (read from localStorage).
 *  - agentView       : the currently opened agent detail view, or null.
 *  - gwStatus        : gateway/connector status map.
 */
const S = {
  config: { company: { name: "BuildEx" }, roots: [] },
  tabs: [],
  active: null,
  rightTab: "files",
  tree: [],
  treeFilter: "",
  projects: [],
  activeProject: null,
  apps: [],
  hist: [],
  hp: -1,
  navLock: false,
  // Restore the persisted "show agent files" preference; default off if storage is unavailable.
  showAgentFiles: (() => {
    try {
      return localStorage.getItem("buildex.showAgentFiles") === "1";
    } catch (_) {
      return false;
    }
  })(),
  agentView: null,
  gwStatus: {},
};

/** Monotonic counter feeding unique tab ids ("t1", "t2", …); see addTab() in tabs.js. */
let tabSeq = 0;
