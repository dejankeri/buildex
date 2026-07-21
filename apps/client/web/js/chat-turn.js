"use strict";
// One agent turn in the chat thread: the collapsible working trace, the incrementally-rendered
// answer body, the code-block chrome, and the per-message actions (copy / retry / edit).
//
// Three things here exist because a chat that STREAMS is not a chat that renders once:
//   * mdInto() diffs the rendered markdown block-by-block, so a token only touches the tail of the
//     DOM. Re-setting one big innerHTML per token (what we did before) destroyed any text selection
//     the operator had made and re-parsed the whole answer ~50 times a second.
//   * follower() only auto-scrolls while the operator is already at the bottom. Scroll up to re-read
//     something mid-turn and the thread stops yanking you back down; a pill offers the ride back.
//   * the turn shows a live elapsed timer from the moment it opens, so pressing Send never lands on
//     an empty thread while the agent spins up.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via <script src>,
// sharing one global scope. NOT an ES module. Uses globals: el, elt, esc, escAttr, mdBlocks.

/** Copy `text` to the clipboard, falling back to a hidden textarea where the async API is blocked
 *  (older Electron surfaces, insecure contexts). Resolves true on success. */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("aria-hidden", "true");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (e) {
    return false;
  }
}

/** Flash a button's label to confirm an action, then restore it. */
function flashLabel(btn, done) {
  const was = btn.textContent;
  btn.textContent = done;
  btn.classList.add("did");
  setTimeout(() => {
    btn.textContent = was;
    btn.classList.remove("did");
  }, 1100);
}

/**
 * Give every fenced code block inside `root` its chrome: a language label and a Copy button. The
 * <pre> is wrapped in place, so the caller's block↔child alignment is preserved (one wrapper per
 * block). Idempotent - a block is only ever wrapped once.
 * @param {Element} root - a rendered block (or a container of them).
 */
function enhanceCode(root) {
  if (!root || !root.querySelectorAll) return;
  const pres = [];
  if (root.tagName === "PRE" && root.classList.contains("cb")) pres.push(root);
  root.querySelectorAll("pre.cb").forEach((p) => pres.push(p));
  for (const pre of pres) {
    if (pre.dataset.wrapped === "1" || !pre.parentNode) continue;
    pre.dataset.wrapped = "1";
    const copy = el("button", {
      class: "cb-copy",
      text: "Copy",
      "aria-label": "Copy code",
      onClick: () => copyText(pre.textContent).then((ok) => flashLabel(copy, ok ? "Copied" : "Failed")),
    });
    const lang = pre.getAttribute("data-lang") || "";
    const wrap = el("div", { class: "codewrap" }, el("div", { class: "cb-bar" }, el("span", { class: "cb-lang", text: lang || "text" }), copy));
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    highlight(pre, lang);
  }
}

/**
 * Colour a finished code block with the vendored highlight.js.
 *
 * Two guards matter here. It is skipped while the fence is still OPEN (`cb-open`), because a
 * streaming block is replaced on every token and re-tokenising it each time would be pure waste -
 * the colour lands the moment the closing fence arrives. And the whole thing is optional: if
 * `hljs` isn't loaded (the jsdom test harness skips vendor/), the block simply stays monochrome.
 *
 * Safety: highlight.js reads the block's textContent - which md.js already escaped - and rewrites it
 * as span-wrapped, re-escaped markup. No un-escaped source ever reaches it.
 * @param {Element} pre - the <pre class="cb"> to colour.
 * @param {string} lang - the fence's info string, or "" to let hljs guess.
 */
function highlight(pre, lang) {
  if (typeof hljs === "undefined" || pre.classList.contains("cb-open")) return;
  const code = pre.querySelector("code");
  if (!code) return;
  try {
    const src = code.textContent;
    const known = lang && hljs.getLanguage && hljs.getLanguage(lang);
    const res = known ? hljs.highlight(src, { language: lang, ignoreIllegals: true }) : hljs.highlightAuto(src);
    code.innerHTML = res.value; // hljs output: the source re-escaped, wrapped in .hljs-* spans
    code.classList.add("hljs");
  } catch (e) {
    /* a grammar that throws must never cost the operator their answer - leave it monochrome */
  }
}

/**
 * Render `src` markdown into `node`, reusing every leading block whose HTML is unchanged. Returns
 * nothing; the node's rendered block list is remembered on it for the next call.
 * @param {Element} node - the container to render into (owned entirely by this function).
 * @param {string} src - markdown source, typically the answer so far.
 */
function mdInto(node, src) {
  const blocks = mdBlocks(src);
  const prev = node._blocks || [];
  let same = 0;
  while (same < blocks.length && same < prev.length && blocks[same] === prev[same]) same++;
  while (node.children.length > same) node.removeChild(node.lastChild);
  for (let k = same; k < blocks.length; k++) {
    // Trusted markup: mdBlocks() escapes every interpolation, so this is the one deliberate
    // innerHTML in the chat path (see web/md.js). Each block is exactly one element.
    const holder = elt("div", null, blocks[k]);
    const child = holder.firstElementChild;
    if (!child) continue;
    node.appendChild(child);
    enhanceCode(child);
  }
  node._blocks = blocks;
}

/**
 * Autoscroll that respects the operator. While the thread is pinned (the operator is at the bottom)
 * `follow()` keeps it there; the moment they scroll up, following stops and a "jump to latest" pill
 * appears until they come back or tap it.
 * @param {Element} thread - the scrolling thread element.
 * @returns {{follow:Function, pin:Function, dispose:Function}} controller.
 */
function follower(thread) {
  let pinned = true;
  const pill = el("button", { class: "jump", text: "↓ Latest", "aria-label": "Jump to latest", onClick: () => api.pin() });
  pill.style.display = "none";
  // The pill is positioned against the pane, not the scrolling thread, so it doesn't scroll away.
  if (thread.parentNode) thread.parentNode.appendChild(pill);
  // 24px of slack: "at the bottom" must survive sub-pixel layout and the last line's descenders.
  const atBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
  const onScroll = () => {
    pinned = atBottom();
    pill.style.display = pinned ? "none" : "";
  };
  thread.addEventListener("scroll", onScroll, { passive: true });
  const api = {
    /** Scroll to the bottom if (and only if) the operator hasn't scrolled away. */
    follow() {
      if (pinned) thread.scrollTop = thread.scrollHeight;
    },
    /** Force back to the bottom and resume following. */
    pin() {
      pinned = true;
      pill.style.display = "none";
      thread.scrollTop = thread.scrollHeight;
    },
    dispose() {
      thread.removeEventListener("scroll", onScroll);
      pill.remove();
    },
  };
  return api;
}

/** A clock-time label ("14:03") for a message, from epoch millis (or now). */
function clockTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/**
 * Append the operator's own message to a thread, with its actions (copy, edit & resend).
 * @param {object} tab - the chat tab.
 * @param {string} text - the message.
 * @param {object} [opts] - `{at}` epoch millis for replay; `onEdit(text)` enables Edit & resend.
 * @returns {Element} the appended turn node.
 */
function userTurn(tab, text, opts) {
  const o = opts || {};
  const bubble = el("div", { class: "bubble op", text });
  const actions = el("div", { class: "msg-actions" });
  const copy = el("button", { class: "ma", text: "Copy", onClick: () => copyText(text).then((ok) => flashLabel(copy, ok ? "Copied" : "Failed")) });
  actions.appendChild(copy);
  if (o.onEdit) actions.appendChild(el("button", { class: "ma", text: "Edit", onClick: () => o.onEdit(text) }));
  const node = el(
    "div",
    { class: "turn turn-in user" },
    el("div", { class: "who" }, el("span", { class: "av op", text: "You" }), el("span", { class: "nm", text: "You" }), el("span", { class: "ts", text: clockTime(o.at) })),
    bubble,
    actions,
  );
  tab.thread.appendChild(node);
  return node;
}

/**
 * Mount an agent turn into the thread and return a controller for streaming its parts.
 *
 * The turn is a collapsible "working" trace (thinking + tool steps) above an always-visible answer
 * body. Narration text emitted before/between tool calls is folded into the trace; only the final
 * text run (after the last tool) stays as the answer. The trace shows a live elapsed timer from the
 * moment the turn opens, so there is never dead air after Send.
 *
 * @param {object} tab - the chat tab whose thread receives the turn.
 * @param {object} [opts] - `{live}` runs the elapsed timer (false when replaying history);
 *   `{model}` badges the model used; `{at}` epoch millis for the timestamp; `{follow}` the
 *   follower to nudge after each mutation; `{onRetry}` enables the Retry action.
 * @returns {object} controller: `think`/`tool`/`toolDone` feed the trace, `setText`/`addText` set the
 *   answer, `fail` renders an error affordance, `done` freezes the summary once the stream ends.
 */
function agentTurn(tab, opts) {
  const o = opts || {};
  const nudge = () => o.follow && o.follow.follow();
  const head = el(
    "div",
    { class: "who" },
    el("span", { class: "av ag", text: "✦" }),
    el("span", { class: "nm", text: "Agent" }),
    o.model ? el("span", { class: "mbadge", text: o.model }) : null,
    el("span", { class: "ts", text: clockTime(o.at) }),
  );
  const label = el("span", { class: "wk-label", text: o.live === false ? "Worked" : "Working" });
  const latest = el("span", { class: "wk-latest" });
  const thinkEl = el("div", { class: "wk-think" });
  const steps = el("div", { class: "wk-steps" });
  const work = el("details", { class: "work" }, el("summary", null, label, latest), el("div", { class: "wk-body" }, thinkEl, steps));
  const body = el("div", { class: "md" });
  const actions = el("div", { class: "msg-actions" });
  const node = el("div", { class: "turn turn-in agent" }, head, work, body, actions);
  tab.thread.appendChild(node);

  let cur = "",
    steps_n = 0,
    shown = o.live !== false,
    finished = false,
    elapsed = 0;
  const started = Date.now();
  // A live turn reveals its trace immediately (with a ticking timer) so Send never lands on nothing.
  // A replayed turn only reveals it once there is something to show.
  if (o.live === false) work.style.display = "none";
  const tick = o.live === false ? null : setInterval(() => {
    elapsed = Math.round((Date.now() - started) / 1000);
    if (!finished) latest.textContent = " · " + elapsed + "s";
  }, 1000);
  const show = () => {
    if (!shown) {
      shown = true;
      work.style.display = "";
    }
  };
  const tip = (s) => {
    if (!finished) latest.textContent = " · " + s;
  };
  // Text the agent emits BEFORE/BETWEEN tool calls is narration ("Let me read the metrics…"), not the
  // answer. When a tool arrives, fold the current text run into the trace and clear the answer body -
  // so only the final run (after the last tool) remains as the answer. The Claude Code pattern.
  const flush = () => {
    if (cur.trim()) {
      show();
      steps.appendChild(el("div", { class: "wk-note", text: cur.trim() }));
    }
    cur = "";
    body.innerHTML = "";
    body._blocks = [];
  };
  const api = {
    think(t) {
      show();
      thinkEl.textContent = t;
      tip("thinking");
      nudge();
    },
    tool(e) {
      flush();
      show();
      steps_n++;
      steps.appendChild(
        el(
          "div",
          { class: "tool" },
          el("span", { class: "tk", text: e.name }),
          e.path ? el("span", { class: "path", text: e.path }) : null,
          el("span", { class: "st2", dataset: { id: String(e.id == null ? "" : e.id) } }),
        ),
      );
      tip(e.name + (e.path ? " " + String(e.path).split("/").pop() : ""));
      nudge();
    },
    toolDone(e) {
      const s = steps.querySelector('.st2[data-id="' + String(e.id == null ? "" : e.id).replace(/["\\]/g, "") + '"]');
      if (s) s.textContent = e.ok ? "✓" : "✕";
    },
    setText(t) {
      cur = t;
      mdInto(body, cur);
      nudge();
    },
    addText(t) {
      cur += t;
      mdInto(body, cur);
      nudge();
    },
    /** Render a real error affordance (not markdown prose) with a Retry when the caller offers one. */
    fail(message, onRetry) {
      const retry = onRetry ? el("button", { class: "ma", text: "Retry", onClick: onRetry }) : null;
      body.appendChild(el("div", { class: "turn-error" }, el("span", { class: "te-ic", "aria-hidden": "true", text: "⚠" }), el("span", { class: "te-msg", text: message }), retry));
      nudge();
    },
    /** The answer text so far - what Copy and Retry act on. */
    text: () => cur,
    // Called once the turn's stream ends (the caller knows the boundary). Freezes the summary to the
    // final step count - the agent emits text before AND after tool calls, so we can't finalize on text.
    done() {
      if (tick) clearInterval(tick);
      if (finished) return;
      finished = true;
      if (shown) {
        label.textContent = "Worked";
        const secs = elapsed || Math.round((Date.now() - started) / 1000);
        latest.textContent = " · " + steps_n + " step" + (steps_n === 1 ? "" : "s") + (o.live === false ? "" : " · " + secs + "s");
      } else {
        work.style.display = "none";
      }
      // Actions land only once the answer is final - a half-streamed answer isn't worth copying.
      if (cur.trim()) {
        const copy = el("button", { class: "ma", text: "Copy", onClick: () => copyText(api.text()).then((ok) => flashLabel(copy, ok ? "Copied" : "Failed")) });
        actions.appendChild(copy);
      }
      if (o.onRetry) actions.appendChild(el("button", { class: "ma", text: "Retry", onClick: o.onRetry }));
    },
    node,
  };
  return api;
}
