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
 *  - treeOpen        : which folders are expanded, by path, so a repaint keeps the operator's place.
 *  - projects        : left-rail projects (task containers).
 *  - activeProject   : id of the selected project, or null.
 *  - apps            : installed apps/skills catalogue.
 *  - hist/hp         : title-bar back/forward focus-history stack and its cursor.
 *  - navLock         : true while replaying history, to suppress re-recording the focus.
 *  - showAllFiles    : persisted toggle for the Files panel's "show everything" mode - the shared
 *                      `core` library plus the agent's derived `.claude` surface (localStorage).
 *  - agentView       : the currently opened agent detail view, or null.
 *  - gwStatus        : gateway/connector status map.
 */
const S = {
  config: { company: { name: "BuildEx" }, roots: [] },
  tabs: [],
  active: null,
  rightTab: "brain",
  tree: [],
  treeFilter: "",
  treeOpen: {},
  // Brain map (right panel): the live snapshot, the Company/Private scope lens, and which loop stages
  // are expanded (by key, so a repaint keeps the operator's place - same contract as treeOpen).
  brain: null,
  brainScope: "all",
  brainOpen: {},
  projects: [],
  activeProject: null,
  apps: [],
  hist: [],
  hp: -1,
  navLock: false,
  // Restore the persisted "show everything" preference; default off if storage is unavailable.
  showAllFiles: (() => {
    try {
      return localStorage.getItem("buildex.showAllFiles") === "1";
    } catch (_) {
      return false;
    }
  })(),
  agentView: null,
  gwStatus: {},
};

/** Monotonic counter feeding unique tab ids ("t1", "t2", …); see addTab() in tabs.js. */
let tabSeq = 0;
