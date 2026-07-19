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
