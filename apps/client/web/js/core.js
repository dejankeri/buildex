"use strict";
// DOM + fetch micro-helpers ($ $$ elt ago getJSON postJSON). esc/escAttr/md live in md.js.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// The tiny shared toolkit every other console module builds on: querying, element creation,
// relative-time formatting, and JSON fetch/post. Holds no state.

/**
 * querySelector shorthand.
 * @param {string} s - CSS selector.
 * @param {ParentNode} [r] - root to search within; defaults to `document`.
 * @returns {Element|null} the first match.
 */
const $ = (s, r) => (r || document).querySelector(s),
  /**
   * querySelectorAll shorthand, returned as a real array (spread, so `.map`/`.forEach` work).
   * @param {string} s - CSS selector.
   * @param {ParentNode} [r] - root to search within; defaults to `document`.
   * @returns {Element[]} all matches.
   */
  $$ = (s, r) => [...(r || document).querySelectorAll(s)];

/**
 * Create an element with an optional class and inner HTML.
 * @param {string} t - tag name.
 * @param {string} [c] - className to apply.
 * @param {string} [h] - innerHTML to set (skipped when null/undefined).
 * @returns {HTMLElement} the new element.
 */
const elt = (t, c, h) => {
  const e = document.createElement(t);
  if (c) e.className = c;
  if (h != null) e.innerHTML = h;
  return e;
};

// esc()/escAttr()/md() live in web/md.js - extracted so the A1 XSS tests can pin them (full module split is C1).

/**
 * Format a past timestamp as a compact relative age ("now" / "5m" / "3h" / "2d").
 * @param {number} ts - epoch millis in the past.
 * @returns {string} the coarsest human-readable age bucket.
 */
const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
};

/**
 * Ask before something destructive, on the console's own overlay. Never window.confirm: a native
 * dialog blocks the Electron bridge's event loop (the same reason every other prompt here is an
 * .ovbackdrop). Cancel is the default - Esc, the backdrop, and Cancel all leave the work undone.
 * @param {{title:string, body:string, confirm?:string, onConfirm:Function}} o - copy + the action.
 */
function confirmAction(o) {
  const bd = elt("div", "ovbackdrop");
  bd.innerHTML = '<div class="ovcard"><h3 class="ovh">' + esc(o.title) + '</h3><p class="ovp">' + esc(o.body) + "</p>"
    + '<div class="ovrow"><button class="mini ghost ovno">Cancel</button><button class="mini ovdanger ovyes">' + esc(o.confirm || "Delete") + "</button></div></div>";
  document.body.appendChild(bd);
  const close = () => {
    bd.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  bd.onclick = (e) => {
    if (e.target === bd) close();
  };
  $(".ovno", bd).onclick = close;
  $(".ovyes", bd).onclick = () => {
    close();
    o.onConfirm();
  };
}

/**
 * Ask for one short string (a file or folder name) on the console's own overlay - never
 * window.prompt, for the same event-loop reason as confirmAction. Enter commits, Esc cancels, and an
 * empty value can never be submitted, so the caller only ever receives a non-empty trimmed string.
 * @param {{title:string, label:string, value?:string, placeholder?:string, confirm?:string,
 *          onConfirm:(value:string)=>void}} o - copy + the action.
 */
function promptAction(o) {
  const bd = elt("div", "ovbackdrop");
  bd.innerHTML = '<div class="ovcard"><h3 class="ovh">' + esc(o.title) + "</h3>"
    + '<label class="ovlabel">' + esc(o.label) + '<input class="ovinput" value="' + escAttr(o.value || "") + '" placeholder="' + escAttr(o.placeholder || "") + '"></label>'
    + '<div class="ovrow"><button class="mini ghost ovno">Cancel</button><button class="mini ovyes">' + esc(o.confirm || "Create") + "</button></div></div>";
  document.body.appendChild(bd);
  const inp = $(".ovinput", bd);
  const close = () => bd.remove();
  const go = () => {
    const v = inp.value.trim();
    if (!v) return inp.focus(); // nothing to name - stay put rather than create "Untitled"
    close();
    o.onConfirm(v);
  };
  bd.onclick = (e) => {
    if (e.target === bd) close();
  };
  inp.onkeydown = (e) => {
    if (e.key === "Enter") go();
    if (e.key === "Escape") close();
  };
  $(".ovno", bd).onclick = close;
  $(".ovyes", bd).onclick = go;
  inp.focus();
  inp.select();
}

/**
 * Flash a short message at the bottom of the window. Used for the outcome of a background action the
 * operator can't otherwise see - above all a REFUSAL from the daemon, whose message is written for
 * them ("the shared BuildEx library is read-only"), so it must not be swallowed.
 * @param {string} msg - the message (plain text).
 * @param {boolean} [bad] - true to style it as a failure.
 */
function toast(msg, bad) {
  const t = elt("div", "toast" + (bad ? " bad" : ""));
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

/**
 * GET a URL and parse its JSON, throwing on any non-2xx response.
 * @param {string} p - request path.
 * @returns {Promise<any>} the parsed JSON body.
 */
async function getJSON(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error(p + " " + r.status);
  return r.json();
}

/**
 * POST a JSON body to a URL and parse the JSON response (does not check response status).
 * @param {string} p - request path.
 * @param {any} b - value to JSON-encode as the request body.
 * @returns {Promise<any>} the parsed JSON body.
 */
async function postJSON(p, b) {
  const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return r.json();
}
