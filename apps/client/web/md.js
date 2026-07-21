// Markdown renderer + HTML escapers for the operator console (web/index.html).
//
// A small block-then-inline renderer, written for ONE hard constraint the old regex pass could not
// meet: it is **streaming-tolerant**. The chat pane re-renders the agent's answer on every token, so
// half-written markdown is the normal case, not the edge case. An unterminated ``` fence renders as
// an open code block (marked `cb-open`) instead of leaking literal backticks into the prose, and a
// half-typed table/list degrades to text rather than to garbage.
//
// Security posture is unchanged and is the reason this file has its own suite (src/md.test.ts):
// every path escapes before it interpolates, and a link target must clear safeHref() or the raw
// markdown renders as plain text. Blocks are assembled from escaped fragments only - no branch
// interpolates raw source into markup.
//
// This file must stay a *classic* script (no import/export): index.html loads it via
// <script src="md.js"> ahead of every other module, and src/md.test.ts side-effect-imports it and
// reads the globals.
"use strict";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const escAttr = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A markdown link target lands inside href="…", so two rules keep hostile input inert: the
// scheme must be allowlisted (https/http/mailto - javascript:, data:, etc. return null and the
// caller renders the raw markdown as plain text instead of a link), and quotes are escaped so
// the URL can't close the attribute. The input has already been through esc() (& < > are
// entities), so only the quotes are escaped here - a full escAttr() pass would double-encode &.
// Allow absolute web/mail links, OR a strictly path-like relative link (the brain's own
// cross-references, e.g. `model.md` / `../decisions/log.md`). The relative branch is a tight
// allowlist: no leading `/` or `\` (blocks protocol-relative `//host` and the `\\host` form browsers
// normalize to it), and only path characters — so any explicit scheme (javascript:, data:, file:)
// or host-bearing value is refused → the raw markdown renders as plain text.
const safeHref = (u) => {
  u = String(u == null ? "" : u);
  const ok = /^(?:https?|mailto):/i.test(u) || /^(?![/\\])[A-Za-z0-9_./-]+$/.test(u);
  return ok ? u.replace(/"/g, "&quot;").replace(/'/g, "&#39;") : null;
};

// --- inline ---------------------------------------------------------------------------------

/**
 * Render one line's inline markup. The source is escaped FIRST, so every rule below operates on
 * already-inert text and can never re-open a tag. Code spans are stashed behind an invisible 0x01
 * sentinel while emphasis runs, so `**not bold**` inside backticks stays literal.
 * @param {string} s - raw source text for one line/paragraph.
 * @returns {string} HTML.
 */
function mdInline(s) {
  let h = esc(s);
  const code = [];
  h = h.replace(/`([^`]+)`/g, (m, c) => {
    code.push(c);
    return "\u0001" + (code.length - 1) + "\u0001";
  });
  h = h.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, t, u) => {
    const href = safeHref(u);
    return href == null ? m : '<a href="' + href + '" target="_blank" rel="noopener">' + t + "</a>";
  });
  h = h
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return h.replace(/\u0001(\d+)\u0001/g, (m, i) => "<code>" + code[+i] + "</code>");
}

// --- block helpers --------------------------------------------------------------------------

const MD_FENCE = /^\s{0,3}```([A-Za-z0-9_+#-]*)\s*$/;
const MD_FENCE_END = /^\s{0,3}```\s*$/;
const MD_HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const MD_HEAD = /^\s{0,3}(#{1,6})\s+(.*)$/;
const MD_QUOTE = /^\s{0,3}>/;
const MD_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const MD_ROW = /^\s*\|.*\|\s*$/;
const MD_DIVIDER = /^\s*\|(?:\s*:?-{1,}:?\s*\|)+\s*$/;

/** True when `l` opens a block that must interrupt an in-progress paragraph. */
function mdBlockStart(l) {
  return MD_FENCE.test(l) || MD_HR.test(l) || MD_HEAD.test(l) || MD_QUOTE.test(l) || MD_ITEM.test(l) || MD_ROW.test(l);
}

/**
 * A fenced code block. `open` marks a fence the stream has not closed yet, so the chat pane can
 * style it as still-arriving rather than flashing raw backticks.
 * @param {string} code - the block's literal contents.
 * @param {string} lang - the info string (may be empty).
 * @param {boolean} open - true when no closing fence has arrived.
 * @returns {string} HTML.
 */
function mdCode(code, lang, open) {
  return (
    '<pre class="cb' + (open ? " cb-open" : "") + '"' + (lang ? ' data-lang="' + escAttr(lang) + '"' : "") + "><code>" + esc(code) + "</code></pre>"
  );
}

/** Split a table row into trimmed cell sources (outer pipes dropped). */
function mdCells(l) {
  return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/**
 * Render a pipe table starting at `i` (header row, then the divider that proved it is a table).
 * Column alignment comes from the divider's colons. Ragged rows are padded/truncated to the header's
 * width so a half-streamed row cannot break the grid.
 * @returns {[string, number]} the HTML and the index just past the table.
 */
function mdTable(lines, i) {
  const head = mdCells(lines[i]);
  const align = mdCells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : /^:-+/.test(c) ? "left" : ""));
  const cell = (t, n, tag) => "<" + tag + (align[n] ? ' style="text-align:' + align[n] + '"' : "") + ">" + mdInline(t) + "</" + tag + ">";
  let h = "<table><thead><tr>" + head.map((t, n) => cell(t, n, "th")).join("") + "</tr></thead><tbody>";
  i += 2;
  for (; i < lines.length && MD_ROW.test(lines[i]) && !MD_DIVIDER.test(lines[i]); i++) {
    const row = mdCells(lines[i]);
    h += "<tr>" + head.map((_, n) => cell(row[n] == null ? "" : row[n], n, "td")).join("") + "</tr>";
  }
  return [h + "</tbody></table>", i];
}

/**
 * Render a list starting at `i`, recursing on indentation so nested lists nest in the output. A
 * change of marker kind (bullet ↔ number) at the same indent ends the list, and `- [ ]` / `- [x]`
 * items render as task rows.
 * @returns {[string, number]} the HTML and the index just past the list.
 */
function mdList(lines, i) {
  const first = MD_ITEM.exec(lines[i]);
  const base = first[1].length;
  const ordered = !first[2];
  const items = [];
  while (i < lines.length) {
    const m = MD_ITEM.exec(lines[i]);
    if (!m) break;
    const indent = m[1].length;
    if (indent < base) break;
    if (indent >= base + 2) {
      // deeper marker → a sublist hanging off the item we just emitted.
      const [sub, next] = mdList(lines, i);
      if (!items.length) items.push({ text: "", sub: "" });
      items[items.length - 1].sub += sub;
      i = next;
      continue;
    }
    if (!m[2] !== ordered) break; // bullets and numbers are different lists, even at the same indent
    items.push({ text: m[4], sub: "" });
    i++;
    // lazy continuation: an indented, non-item, non-blank line belongs to the item above it.
    while (i < lines.length && /^\s+\S/.test(lines[i]) && !MD_ITEM.test(lines[i]) && !MD_FENCE.test(lines[i])) {
      items[items.length - 1].text += "\n" + lines[i].trim();
      i++;
    }
  }
  const body = items
    .map((it) => {
      const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
      if (task) return '<li class="task">' + (task[1] === " " ? "☐" : "☑") + " " + mdInline(task[2]) + it.sub + "</li>";
      return "<li>" + mdInline(it.text) + it.sub + "</li>";
    })
    .join("");
  return ["<" + (ordered ? "ol" : "ul") + ">" + body + "</" + (ordered ? "ol" : "ul") + ">", i];
}

// --- the renderer ---------------------------------------------------------------------------

/**
 * Render markdown to an array of top-level block HTML strings. This is the form the chat pane wants:
 * streaming only ever APPENDS, so consecutive renders share a long identical prefix, and the pane can
 * diff block-by-block and touch the DOM only for the tail. That is what keeps a text selection alive
 * while the agent is still writing - re-setting one big innerHTML would destroy it on every token.
 * @param {string} src - markdown source.
 * @returns {string[]} one HTML string per top-level block, each a single element.
 */
function mdBlocks(src) {
  const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const fence = MD_FENCE.exec(l);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !MD_FENCE_END.test(lines[i])) buf.push(lines[i++]);
      const open = i >= lines.length; // the closing fence hasn't streamed in yet
      if (!open) i++;
      out.push(mdCode(buf.join("\n"), fence[1], open));
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    if (MD_HR.test(l)) {
      out.push("<hr>");
      i++;
      continue;
    }
    const head = MD_HEAD.exec(l);
    if (head) {
      const n = head[1].length;
      out.push("<h" + n + ">" + mdInline(head[2].trim()) + "</h" + n + ">");
      i++;
      continue;
    }
    if (MD_QUOTE.test(l)) {
      const buf = [];
      while (i < lines.length && MD_QUOTE.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      out.push("<blockquote>" + md(buf.join("\n")) + "</blockquote>");
      continue;
    }
    if (MD_ROW.test(l) && i + 1 < lines.length && MD_DIVIDER.test(lines[i + 1])) {
      const [html, next] = mdTable(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    if (MD_ITEM.test(l)) {
      const [html, next] = mdList(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    // Paragraph. The first line is taken unconditionally, which is what GUARANTEES progress: a line
    // can look like a block start and still reach here (a `| a | b |` row whose divider hasn't
    // streamed in yet is the real case), and without this the loop would never advance.
    const buf = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !mdBlockStart(lines[i])) buf.push(lines[i++]);
    out.push("<p>" + buf.map(mdInline).join("<br>") + "</p>");
  }
  return out;
}

/**
 * Render markdown to one HTML string. Safe for agent/operator-supplied text: everything is escaped
 * before it is interpolated, and link targets must clear safeHref(). Tolerates truncated input (see
 * the file header) so it can be called on every streamed token.
 * @param {string} src - markdown source.
 * @returns {string} HTML.
 */
function md(src) {
  return mdBlocks(src).join("\n");
}

// Expose to every other classic script and to the test suite. (Top-level consts are already visible
// across classic scripts, but src/md.test.ts imports this file as a module, where only the
// globalThis assignments survive.)
globalThis.esc = esc;
globalThis.escAttr = escAttr;
globalThis.md = md;
globalThis.mdBlocks = mdBlocks;
