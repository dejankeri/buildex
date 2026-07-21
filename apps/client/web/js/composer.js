"use strict";
// The chat composer: the input box and everything the operator does in it — autogrow, drafts,
// Send/Stop, inline `@file` and `/command` completion, ↑ to recall the last message, and
// drag-and-drop of workspace files.
//
// Split out of chat.js because it is a self-contained widget with its own state (draft text, the
// open completion menu, the recall cursor) that the chat pane only needs three verbs from:
// value()/clear()/setBusy(). Keeping it here also means the pane can be rebuilt without the operator
// losing what they had typed — the draft lives on the tab, not in the DOM.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via <script src>,
// sharing one global scope. NOT an ES module. Uses globals: S, el, $, $$, elt, esc, loadTree,
// flattenTree, closeMenus.

/** The slash commands the composer completes. Each expands to a plain prompt — the agent needs no
 *  special casing, and a non-technical operator gets a discoverable menu of the common asks. */
const SLASH_COMMANDS = [
  { cmd: "/summarize", hint: "Summarize this conversation so far", expand: "Summarize this conversation so far." },
  { cmd: "/plan", hint: "Draft a plan before acting", expand: "Before doing anything, draft a short plan and wait for my go-ahead.\n\n" },
  { cmd: "/recap", hint: "What changed in the company this week?", expand: "Recap what changed in the company this week, from the repo." },
  { cmd: "/map", hint: "Show me how this fits the company map", expand: "Show me how this fits into the company map." },
];

/** Longest repo root that contains `abs`, or null — how a dropped OS file becomes an `@path`. */
function repoRelative(abs) {
  const roots = (S.config && S.config.roots) || [];
  let best = null;
  for (const r of roots) {
    const root = typeof r === "string" ? r : r && r.path;
    if (!root) continue;
    if (abs === root || abs.indexOf(root.replace(/\/$/, "") + "/") === 0) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best ? abs.slice(best.replace(/\/$/, "").length + 1) : null;
}

/**
 * Build the composer into `host` and return its controller.
 * @param {object} tab - the chat tab; the draft is persisted on `tab.draft` and the sent-history on
 *   `tab.sent`, so a pane rebuild never loses typing.
 * @param {object} handlers - `{onSend(text), onStop()}`.
 * @returns {{el:Element, focus:Function, value:Function, set:Function, clear:Function, setBusy:Function}}
 */
function buildComposer(tab, handlers) {
  const ta = el("textarea", { rows: "1", "aria-label": "Message your company brain", placeholder: "Ask your company brain…" });
  const attach = el("button", { class: "ctool attach", title: "Attach a workspace file", "aria-label": "Attach a workspace file", text: "📎" });
  // Real, versioned names — the picker IS the visible "active model" indicator, so there is no vague
  // "default" option: a tab with no saved choice shows Sonnet 5, which is what actually runs (the
  // driver's `defaultModel`, see wiring.ts). Keep this list in step with that allowlist.
  const model = el(
    "select",
    { class: "ctool modelsel", title: "Model", "aria-label": "Model" },
    el("option", { value: "sonnet", text: "Sonnet 5" }),
    el("option", { value: "opus", text: "Opus 4.8" }),
    el("option", { value: "haiku", text: "Haiku 4.5" }),
    el("option", { value: "fable", text: "Fable 5" }),
  );
  const effort = el(
    "select",
    { class: "ctool effortsel", title: "Thinking effort", "aria-label": "Thinking effort" },
    el("option", { value: "", text: "Effort: normal" }),
    el("option", { value: "think", text: "Think" }),
    el("option", { value: "think-harder", text: "Think harder" }),
  );
  const send = el("button", { class: "send", text: "Send" });
  const hint = el("span", { class: "chint", text: "" });
  const box = el("div", { class: "box" }, ta, el("div", { class: "crow" }, attach, model, effort, hint, el("span", { class: "cspacer" }), send));
  const menu = el("div", { class: "cmenu" });
  menu.style.display = "none";
  const root = el("div", { class: "composer" }, tab.systemAppend ? el("div", { class: "ctxchip" }) : null, menu, box);

  model.value = tab.model || "sonnet"; // Sonnet 5 is the pinned default (see wiring defaultModel)
  effort.value = tab.effort || "";
  model.onchange = () => (tab.model = model.value || null);
  effort.onchange = () => (tab.effort = effort.value || null);

  let busy = false;
  let recall = -1; // cursor into tab.sent while the operator arrows back through their history

  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };
  const save = () => {
    tab.draft = ta.value;
  };

  // --- inline completion (@file and /command) ------------------------------------------------

  let items = [],
    sel = 0,
    token = null; // {start, end, kind}

  const closeMenu = () => {
    menu.style.display = "none";
    menu.innerHTML = "";
    items = [];
    token = null;
  };

  const applyItem = (it) => {
    if (!token) return;
    const before = ta.value.slice(0, token.start);
    const after = ta.value.slice(token.end);
    const insert = it.insert;
    ta.value = before + insert + after;
    const caret = before.length + insert.length;
    ta.selectionStart = ta.selectionEnd = caret;
    closeMenu();
    save();
    grow();
    ta.focus();
  };

  const drawMenu = () => {
    menu.innerHTML = "";
    if (!items.length) {
      menu.style.display = "none";
      return;
    }
    items.forEach((it, n) => {
      const b = el("button", { class: "cmi" + (n === sel ? " on" : ""), onClick: () => applyItem(it) }, el("span", { class: "cmi-l", text: it.label }), it.hint ? el("span", { class: "cmi-h", text: it.hint }) : null);
      menu.appendChild(b);
    });
    menu.style.display = "";
  };

  /** Look at the caret's word and, if it opens a completion, populate + show the menu. */
  async function updateCompletion() {
    const caret = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const upto = ta.value.slice(0, caret);
    const at = /(^|\s)@([^\s]*)$/.exec(upto);
    const slash = /^\/([a-z]*)$/.exec(upto); // only at the very start — a mid-message "/" is a path
    if (at) {
      if (!(S.tree && S.tree.length)) await loadTree();
      const q = at[2].toLowerCase();
      const paths = flattenTree(S.tree, []).filter((p) => !q || p.toLowerCase().includes(q));
      items = paths.slice(0, 8).map((p) => ({ label: p, hint: "", insert: "@" + p + " " }));
      token = { start: caret - at[2].length - 1, end: caret };
    } else if (slash) {
      const q = slash[1];
      items = SLASH_COMMANDS.filter((c) => c.cmd.startsWith("/" + q)).map((c) => ({ label: c.cmd, hint: c.hint, insert: c.expand }));
      token = { start: 0, end: caret };
    } else {
      closeMenu();
      return;
    }
    sel = 0;
    drawMenu();
  }

  // --- input wiring --------------------------------------------------------------------------

  const go = () => {
    const p = ta.value.trim();
    if (!p || busy) return;
    tab.sent = tab.sent || [];
    tab.sent.push(p);
    recall = -1;
    ta.value = "";
    save();
    grow();
    closeMenu();
    handlers.onSend(p);
  };

  send.onclick = () => (busy ? handlers.onStop() : go());
  ta.addEventListener("input", () => {
    save();
    grow();
    updateCompletion();
  });
  ta.addEventListener("blur", () => setTimeout(closeMenu, 120)); // let a menu click land first
  ta.onkeydown = (e) => {
    if (items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        drawMenu();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyItem(items[sel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        return;
      }
    }
    // ↑ on an empty (or already-recalled) box walks back through what you've sent — terminal-style.
    if (e.key === "ArrowUp" && (!ta.value.trim() || recall >= 0) && tab.sent && tab.sent.length) {
      e.preventDefault();
      recall = recall < 0 ? tab.sent.length - 1 : Math.max(0, recall - 1);
      ta.value = tab.sent[recall];
      save();
      grow();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      return;
    }
    if (e.key === "ArrowDown" && recall >= 0) {
      e.preventDefault();
      recall++;
      ta.value = recall >= tab.sent.length ? ((recall = -1), "") : tab.sent[recall];
      save();
      grow();
      return;
    }
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      handlers.onStop(); // Esc stops a running turn, like every other agent surface
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      go();
    }
  };

  // Drag a file in from Finder/the rail: if it lives under a repo root it becomes an `@path`
  // reference the agent can read. Files outside the workspace are refused with a reason — the daemon
  // has no upload route, and silently dropping them would be worse than saying so.
  root.addEventListener("dragover", (e) => {
    e.preventDefault();
    root.classList.add("dropping");
  });
  root.addEventListener("dragleave", () => root.classList.remove("dropping"));
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    root.classList.remove("dropping");
    const dropped = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    const outside = [];
    let added = 0;
    for (const f of dropped) {
      const rel = f.path ? repoRelative(f.path) : null;
      if (rel) {
        ta.value += (ta.value && !/\s$/.test(ta.value) ? " " : "") + "@" + rel + " ";
        added++;
      } else outside.push(f.name);
    }
    const text = e.dataTransfer && e.dataTransfer.getData("text/plain");
    if (!dropped.length && text) ta.value += (ta.value && !/\s$/.test(ta.value) ? " " : "") + text;
    hint.textContent = outside.length ? outside.length + " file(s) are outside the workspace — move them in first" : "";
    if (added || text) {
      save();
      grow();
      ta.focus();
    }
  });

  // Pasting a screenshot has nowhere to go (no upload route), so say that rather than dropping it.
  ta.addEventListener("paste", (e) => {
    const files = [...(((e.clipboardData || {}).files) || [])];
    if (files.length && files.every((f) => /^image\//.test(f.type))) {
      e.preventDefault();
      hint.textContent = "Images can't be attached yet — save it into the workspace and @-mention it";
    }
  });

  // Restore the draft (a pane rebuild, a tab switch) or an explicit prefill.
  if (tab.draft) ta.value = tab.draft;
  else if (tab.prefill) ta.value = tab.prefill;
  if (ta.value) setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    grow();
  }, 0);

  attach.onclick = () => {
    ta.focus();
    const caret = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    ta.value = ta.value.slice(0, caret) + "@" + ta.value.slice(caret);
    ta.selectionStart = ta.selectionEnd = caret + 1;
    save();
    updateCompletion();
  };

  return {
    el: root,
    focus: () => ta.focus(),
    value: () => ta.value,
    set(v) {
      ta.value = v;
      save();
      grow();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    },
    clear() {
      ta.value = "";
      save();
      grow();
    },
    /** Flip Send↔Stop. While busy the box stays editable (type your next message), Enter is inert. */
    setBusy(v) {
      busy = !!v;
      send.textContent = busy ? "Stop" : "Send";
      send.classList.toggle("stopping", busy);
      send.setAttribute("aria-label", busy ? "Stop the running turn" : "Send");
      hint.textContent = "";
    },
  };
}
