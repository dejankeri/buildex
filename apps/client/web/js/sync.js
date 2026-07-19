"use strict";
// Title-bar sync dot state machine.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Owns the title-bar sync dot: ok(green) · busy(orange pulse, agent working → changes will
// commit+sync) · off(red, daemon unreachable). Also exposes `syncBusy`, the in-flight-run flag
// that projects.js consults so a running agent's dot wins over the server's reported state.

/** Number of agent runs currently in flight; non-zero means the dot should read "busy". */
let syncBusy = 0;

/**
 * Paint the sync dot for a given state and set its tooltip.
 * @param {"ok"|"busy"|"off"|"queued"|"help"|"local"} state - dot state (unknown values fall back to "Synced" text).
 */
function setSync(state) {
  const dot = $("#sync");
  if (!dot) return;
  dot.classList.remove("ok", "busy", "off", "queued", "help", "local");
  dot.classList.add(state);
  const label =
    {
      ok: "Synced",
      busy: "Syncing…",
      off: "Offline - will retry",
      queued: "Saved - will sync when back online",
      help: "Needs attention - a change couldn't sync automatically",
      local: "Local workspace - everything stays on your machine (team sync accounts are coming)",
    }[state] || "Synced";
  dot.title = label + " · click for recent changes";
  // a11y: #sync is a role="status" live region, so a state change is announced (the dot itself
  // carries no text). Keep the accessible name in step with the state.
  dot.setAttribute("aria-label", "Sync status: " + label);
}
