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
 * @param {"ok"|"busy"|"off"|"queued"|"help"|"local"|"unsaved"} state - dot state (unknown values fall back to "Synced" text).
 */
function setSync(state) {
  const dot = $("#sync");
  if (!dot) return;
  dot.classList.remove("ok", "busy", "off", "queued", "help", "local", "unsaved");
  dot.classList.add(state);
  const label =
    {
      ok: "Synced",
      busy: "Syncing…",
      off: "Offline - will retry",
      // The offline retry is bounded (a handful of attempts with backoff) - once it gives up,
      // coming back online does nothing on its own. Never promise an automatic retry here; say
      // only what stays true either way: the work is safe on this machine, waiting to be sent.
      queued: "Saved on this machine - click Save again to send it",
      help: "Needs attention - a change couldn't sync automatically",
      // "local" only ever paints once syncDotState (projects.js) has decided there's no connected
      // account - so this copy retires on its own the moment the operator connects one (Task 10);
      // it must never claim accounts are still "coming", since that's exactly what this state means.
      local: "Local workspace - stays on this machine until you connect an account",
      unsaved: "You have unsaved work · click to save",
    }[state] || "Synced";
  // "unsaved" already tells the operator what the click does (save); every other state's click opens
  // the change log, so only those get the generic suffix - otherwise the tooltip would say both.
  dot.title = state === "unsaved" ? label : label + " · click for recent changes";
  // a11y: #sync is a role="status" live region, so a state change is announced (the dot itself
  // carries no text). Keep the accessible name in step with the state.
  dot.setAttribute("aria-label", "Sync status: " + label);
}
