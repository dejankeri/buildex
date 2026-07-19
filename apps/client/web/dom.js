"use strict";
// Safe DOM builder for the operator console. The console historically rendered every
// surface by concatenating HTML strings into `.innerHTML` (123 sites); correctness there depends on
// remembering to esc()/escAttr() every interpolation, and one miss is a stored-XSS hole. `el()` builds
// real DOM nodes instead: text goes through `textContent` and attribute values through `setAttribute`,
// so operator/agent-supplied content can NEVER be parsed as markup - it is safe by construction, not
// by discipline. Renderers migrate off innerHTML onto this, surface by surface, behind the jsdom test
// net (console-render*.test.ts).
//
// Classic script - loaded (after md.js, before js/*) via <script src> in web/index.html, sharing one
// global scope. NOT an ES module. `el`/`txt`/`frag` become globals for every module to use.

/**
 * Build a DOM element with attributes, event handlers, and children - all escaped by construction.
 * @param {string} tag - the element tag name.
 * @param {object|null} [attrs] - attributes. Special keys: `class`/`className` set the class; `text`
 *   sets textContent (safe); `dataset` is an object of data-* values; `on<Event>` (a function) wires a
 *   listener (e.g. `onClick`); `html` is an ESCAPE HATCH that sets innerHTML from TRUSTED markup only
 *   (avoid it for any operator/agent content). Any other key sets an attribute; false/null skips it.
 * @param {...(Node|string|number|false|null|Array)} children - appended in order; strings/numbers
 *   become text nodes (escaped), nested arrays are flattened, and false/null are skipped.
 * @returns {HTMLElement} the constructed element.
 */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class" || k === "className") node.className = v;
      else if (k === "text") node.textContent = v; // safe: never parsed as HTML
      else if (k === "html") node.innerHTML = v; // TRUSTED markup only - the deliberate escape hatch
      else if (k === "dataset") for (const d in v) node.dataset[d] = v[d];
      else if (k.length > 2 && k.slice(0, 2) === "on" && typeof v === "function") node[k.toLowerCase()] = v;
      else node.setAttribute(k, v); // attribute value is set as data, never parsed as markup
    }
  }
  append(node, children);
  return node;
}

/** Append children (Node | string | number | false | null | nested arrays) to a parent, flattening
 *  arrays, turning strings/numbers into (escaped) text nodes, and skipping false/null. */
function append(parent, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.append(c && c.nodeType ? c : document.createTextNode(String(c)));
  }
}

/** A text node from a value (safe by construction). */
function txt(s) {
  return document.createTextNode(String(s == null ? "" : s));
}

/** A DocumentFragment of the given children (same coercion rules as `el` children) - lets a renderer
 *  return several siblings without a wrapper element. */
function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}
