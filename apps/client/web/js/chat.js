"use strict";
// Chat pane: the thread, the session load/replay, and the streamed agent turn.
//
// The pane owns three things the composer and turn renderer don't:
//   * the turn's AbortController. Stop aborts the fetch, which cancels the response body, which the
//     daemon sees as a client disconnect and turns into an abort of the agent child (daemon.ts's
//     stream cancel()). So Stop needs no route of its own — and an aborted turn is a clean stop, not
//     an error, exactly as the daemon records it.
//   * retry / edit-and-resend, which are just "send this text again" with the previous turn dropped.
//   * re-attaching after a reload. A turn keeps running server-side when the page goes away, and the
//     session store keeps appending its events, so a session found in "running" state is polled until
//     it settles and the new events are replayed. Without this, reloading mid-turn lost the answer.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via <script src>,
// sharing one global scope. NOT an ES module. Uses globals: S, $, el, elt, esc, getJSON,
// buildComposer, agentTurn, userTurn, follower, renderTabbar, refreshPending, refreshProjects,
// setSync, syncBusy, connectApp, loadTree.

/** How often a re-attached (server-side still running) turn re-reads its session. */
const REATTACH_POLL_MS = 1200;

/**
 * Build the composer + thread into `tab.pane`. Safe to call again on the same tab — the draft and
 * sent-history live on the tab, so a rebuild loses nothing.
 * @param {object} tab - the chat tab; `tab.pane` is mounted, `tab.thread` is set to the thread div.
 */
function buildChatPane(tab) {
  tab.pane.classList.add("on");
  tab.pane.innerHTML = "";
  tab.thread = el("div", { class: "thread" });
  tab.pane.appendChild(tab.thread);
  tab.composer = buildComposer(tab, { onSend: (p) => sendPrompt(tab, p), onStop: () => stopTurn(tab) });
  tab.pane.appendChild(tab.composer.el);
  tab.follow = follower(tab.thread);
  // Tear down the scroll listener + any in-flight turn when the tab closes (tabs.js calls dispose).
  tab.dispose = () => {
    if (tab.follow) tab.follow.dispose();
    stopTurn(tab);
    if (tab.reattachTimer) clearTimeout(tab.reattachTimer);
  };
  if (tab.systemAppend) renderCtxChip(tab);
  if (appGateActive(tab)) renderAppGate(tab);
}

/**
 * Is this chat waiting on an app connection? True for an app-scoped chat whose gateway tools aren't
 * authorized yet, unless the operator explicitly chose to chat without them.
 * @param {object} tab - the chat tab.
 */
function appGateActive(tab) {
  return !!(tab && tab.app && tab.appConn && tab.appConn.needsAuth && !tab.connSkipped);
}

/**
 * The connect gate: an app chat that can't reach its app says so in the CENTRE of the pane, not in a
 * chip someone can miss, and the composer is locked while it's up. A chat with dead tools is the one
 * failure a non-technical operator can't diagnose - they'd ask the agent to do something, watch it
 * answer from thin air, and never learn why. Two ways out: Connect (the real fix), or Skip, which
 * drops the app context entirely so the chat is honestly a plain chat.
 * @param {object} tab - the chat tab; `tab.app` and `tab.appConn` describe the unconnected app.
 */
function renderAppGate(tab) {
  const app = tab.app;
  const title = app.title || app.name;
  const glyph = app.icon && app.icon.length <= 3 ? app.icon : "🔌";
  tab.thread.innerHTML = "";
  const gate = el(
    "div",
    { class: "conngate" },
    el("div", { class: "cg-ic", text: glyph }),
    el("h3", { class: "cg-h", text: title + " isn’t connected" }),
    el("p", { class: "cg-p", text: "The AI can’t read or act in " + title + " until you authorize it. This takes one sign-in." }),
    el("button", {
      class: "cg-go",
      text: "Connect " + title,
      onClick: () => (typeof openConnectDialog === "function" ? openConnectDialog(app) : connectApp(app, tab.appConn)),
    }),
    el("button", {
      class: "cg-skip",
      text: "Skip — chat without " + title,
      onClick: () => {
        tab.connSkipped = true;
        tab.systemAppend = null; // no app context at all, rather than context the agent can't act on
        const chip = $(".ctxchip", tab.pane);
        if (chip) chip.remove();
        clearAppGate(tab);
      },
    }),
  );
  tab.thread.appendChild(gate);
  if (tab.composer && tab.composer.setLocked) tab.composer.setLocked(true, "Connect " + title + " to start");
}

/** Take the gate down and hand the chat back: unlock the composer and restore the empty state. */
function clearAppGate(tab) {
  const gate = $(".conngate", tab.pane);
  if (gate) gate.remove();
  if (tab.composer && tab.composer.setLocked) tab.composer.setLocked(false);
  if (tab.thread && !tab.thread.children.length) {
    tab.thread.appendChild(el("div", { class: "empty" }, el("div", { class: "big", text: "◈" }), 'Ask about your brain - try "Summarize our Q3 metrics and charter."'));
  }
}

/**
 * Re-read a tab's app connection from the latest gateway poll and react if it flipped. Called for
 * every tab on each refreshApps tick, so an OAuth finished in the browser clears the gate here
 * without a reload - the operator comes back to a chat that just works.
 * @param {object} tab - any tab; non-app-chat tabs are ignored.
 */
function syncAppConn(tab) {
  if (!tab || tab.type !== "chat" || !tab.app || typeof appConn !== "function") return;
  const was = appGateActive(tab);
  tab.appConn = appConn(tab.app.name);
  const now = appGateActive(tab);
  if (was === now) return;
  if (now) renderAppGate(tab);
  else clearAppGate(tab);
  if (tab.systemAppend) renderCtxChip(tab); // chip flips between "not connected" and "tools loaded"
}

/**
 * Render the app-context chip above the composer. It shows which app the chat is oriented to, offers
 * a Connect action when the app's tools aren't authorized yet, and an × that removes the injected
 * context (clears tab.systemAppend so later turns carry no app append).
 * @param {object} tab - the chat tab holding `systemAppend` (+ optional `app`/`appConn`).
 */
function renderCtxChip(tab) {
  const chip = $(".ctxchip", tab.pane);
  if (!chip) return;
  const needsAuth = !!(tab.appConn && tab.appConn.needsAuth);
  const title = (tab.app && tab.app.title) || "this app";
  chip.className = "ctxchip" + (needsAuth ? " warn" : "");
  chip.innerHTML = "";
  chip.append(
    el("span", { class: "cx-ic", text: needsAuth ? "⚠" : "✦" }),
    el(
      "span",
      { class: "cx-tx" },
      needsAuth ? [el("b", { text: title }), " tools aren’t connected yet"] : ["Working with ", el("b", { text: title }), " · tools & skills loaded"],
    ),
    needsAuth && typeof connectApp === "function" ? el("button", { class: "cx-connect", text: "Connect", onClick: () => connectApp(tab.app, tab.appConn) }) : null,
    el("button", {
      class: "cx-x",
      title: "Remove this context",
      "aria-label": "Remove context",
      text: "×",
      onClick: () => {
        tab.systemAppend = null;
        chip.remove();
      },
    }),
  );
}

/**
 * Flatten a nested file tree into a flat list of file paths (depth-first), accumulating into `out`.
 * @param {Array} nodes - tree nodes; each is a file (has `path`) or a dir (has `children`).
 * @param {string[]} out - accumulator, returned.
 * @returns {string[]} `out` with every descendant file path appended.
 */
function flattenTree(nodes, out) {
  (nodes || []).forEach((n) => {
    if (n.type === "file") out.push(n.path);
    else if (n.children) flattenTree(n.children, out);
  });
  return out;
}

/**
 * Fetch a session's stored events and replay them into the tab's thread; shows an empty-state
 * prompt when the session has no events. If the session is still running (the operator reloaded
 * mid-turn), re-attach to it. Network/parse errors are swallowed (blank thread).
 * @param {object} tab - the chat tab; `tab.sessionId` selects the session, `tab.thread` receives it.
 */
async function loadSession(tab) {
  try {
    const s = await getJSON("/api/sessions/" + tab.sessionId);
    if (!s.events || !s.events.length) {
      // An unconnected app chat already owns the empty thread (renderAppGate) — don't paint over it.
      if (!appGateActive(tab)) tab.thread.appendChild(el("div", { class: "empty" }, el("div", { class: "big", text: "◈" }), 'Ask about your brain - try "Summarize our Q3 metrics and charter."'));
    } else {
      renderHistory(tab, s.events);
      tab.replayed = s.events.length;
    }
    if (tab.follow) tab.follow.pin();
    if (s.status === "running") reattach(tab); // a turn is still going server-side — pick it back up
  } catch (e) {
    /* leave the thread blank rather than showing a scary error on first paint */
  }
}

/**
 * Replay a session's event list into the thread, reconstructing operator messages and agent turns.
 *
 * Events carry `role:"user"` since the inline-approvals release; older transcripts don't, so the
 * original heuristic (the first `text` after a `done` is the operator's) still runs as the fallback.
 * @param {object} tab - the chat tab receiving the rendered turns.
 * @param {Array} events - stored events (`text` / `thinking` / `tool` / `tool_result` / `done`).
 */
function renderHistory(tab, events) {
  let turn = null,
    afterDone = true;
  events.forEach((e) => {
    if (e.kind === "done") {
      if (turn) turn.done();
      turn = null;
      afterDone = true;
      return;
    }
    const isUser = e.kind === "text" && (e.role === "user" || (e.role == null && afterDone));
    if (isUser) {
      userTurn(tab, e.text, { at: e.at, onEdit: (t) => editAndResend(tab, t) });
      afterDone = false;
      return;
    }
    if (!turn) turn = agentTurn(tab, { live: false, at: e.at, follow: tab.follow, onRetry: () => retryLast(tab) });
    if (e.kind === "thinking") turn.think(e.text);
    else if (e.kind === "tool") turn.tool(e);
    else if (e.kind === "tool_result") turn.toolDone(e);
    else if (e.kind === "text") turn.addText(e.text);
    else if (e.kind === "error") turn.fail(e.message, () => retryLast(tab));
  });
  if (turn) turn.done(); // the trailing turn may have no `done` event yet - finalize it anyway
}

/**
 * Re-attach to a turn that is still running on the daemon (the page was reloaded mid-turn). There is
 * no server-side replay channel for an in-flight run, but the session store is appended to as the
 * turn streams — so poll it and render whatever is new until the session leaves "running".
 * @param {object} tab - the chat tab to re-attach.
 */
function reattach(tab) {
  if (tab.busy) return;
  tab.busy = true;
  tab.status = "running";
  renderTabbar();
  tab.composer.setBusy(true);
  const note = el("div", { class: "reattach", text: "Picking this turn back up — it kept running while you were away." });
  tab.thread.appendChild(note);
  const poll = async () => {
    let s;
    try {
      s = await getJSON("/api/sessions/" + tab.sessionId);
    } catch (e) {
      tab.reattachTimer = setTimeout(poll, REATTACH_POLL_MS); // daemon blip — keep waiting
      return;
    }
    const fresh = (s.events || []).slice(tab.replayed || 0);
    if (fresh.length) {
      note.remove();
      renderHistory(tab, fresh);
      tab.replayed = (s.events || []).length;
      if (tab.follow) tab.follow.follow();
    }
    if (s.status === "running") {
      tab.reattachTimer = setTimeout(poll, REATTACH_POLL_MS);
      return;
    }
    note.remove();
    tab.busy = false;
    tab.status = s.status === "error" ? "error" : "idle";
    tab.composer.setBusy(false);
    renderTabbar();
  };
  tab.reattachTimer = setTimeout(poll, REATTACH_POLL_MS);
}

/** Abort the tab's in-flight turn. The daemon sees the disconnect and kills the agent child. */
function stopTurn(tab) {
  if (tab.abort) {
    try {
      tab.abort.abort();
    } catch (e) {}
    tab.abort = null;
  }
  if (tab.reattachTimer) {
    clearTimeout(tab.reattachTimer);
    tab.reattachTimer = null;
  }
}

/**
 * Re-send the operator's most recent message. Everything back to and including that message's own
 * bubble is removed first, because sendPrompt() re-appends it — otherwise a retry would stack a
 * second copy of the question above the new answer.
 * @param {object} tab - the chat tab.
 */
function retryLast(tab) {
  const last = tab.sent && tab.sent.length ? tab.sent[tab.sent.length - 1] : null;
  if (!last || tab.busy) return;
  const turns = [...tab.thread.querySelectorAll(".turn")];
  for (let i = turns.length - 1; i >= 0; i--) {
    const isUser = turns[i].classList.contains("user");
    turns[i].remove();
    if (isUser) break; // stop once we've taken the question itself
  }
  sendPrompt(tab, last);
}

/** Put a past message back in the composer so the operator can change it and send again. */
function editAndResend(tab, text) {
  if (tab.busy) return;
  tab.composer.set(text);
}

/**
 * Send `prompt` for `tab`: append the operator bubble, open an agent turn, POST /api/prompt, and
 * stream the response — parsing the SSE-style body (double-newline-delimited JSON frames) into
 * think/tool/tool_result/text calls on the turn. Manages busy/sync state and titles the tab.
 * @param {object} tab - the chat tab sending the prompt.
 * @param {string} prompt - the operator's message text.
 */
async function sendPrompt(tab, prompt) {
  if (tab.busy) return;
  tab.busy = true;
  tab.status = "running";
  renderTabbar();
  tab.composer.setBusy(true);
  syncBusy++;
  setSync("busy");
  const empty = tab.thread.querySelector(".empty");
  if (empty) empty.remove();
  // retryLast() re-sends without going through the composer, so record it here too.
  tab.sent = tab.sent || [];
  if (tab.sent[tab.sent.length - 1] !== prompt) tab.sent.push(prompt);
  userTurn(tab, prompt, { onEdit: (t) => editAndResend(tab, t) });
  const turn = agentTurn(tab, { model: tab.model || null, follow: tab.follow, onRetry: () => retryLast(tab) });
  if (tab.follow) tab.follow.pin();
  const ac = new AbortController();
  tab.abort = ac;
  let got = false;
  try {
    const res = await fetch("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ac.signal,
      body: JSON.stringify({
        prompt,
        sessionId: tab.sessionId,
        ...(tab.model ? { model: tab.model } : {}),
        ...(tab.effort ? { effort: tab.effort } : {}),
        ...(tab.systemAppend ? { systemPromptAppend: tab.systemAppend } : {}),
      }),
    });
    // Stream the response body: decode chunks, split on blank lines into frames, JSON-parse the
    // object starting at the first "{" in each frame. `buf` holds the trailing partial frame.
    const rd = res.body.getReader(),
      dec = new TextDecoder();
    let buf = "",
      think = "";
    for (;;) {
      const c = await rd.read();
      if (c.done) break;
      buf += dec.decode(c.value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop();
      for (const f of frames) {
        const i = f.indexOf("{");
        if (i < 0) continue;
        let e;
        try {
          e = JSON.parse(f.slice(i));
        } catch (x) {
          continue;
        }
        got = true;
        if (e.kind === "thinking") {
          think += e.text;
          turn.think(think);
        } else if (e.kind === "tool") turn.tool(e);
        else if (e.kind === "tool_result") turn.toolDone(e);
        else if (e.kind === "text") turn.addText(e.text);
        else if (e.kind === "error") turn.fail(e.message, () => retryLast(tab));
      }
    }
    if (!got) turn.fail("The agent returned nothing.", () => retryLast(tab));
  } catch (e) {
    // An abort is the operator pressing Stop — a clean end, not a failure worth an error card.
    if (ac.signal.aborted) turn.fail("Stopped.", () => retryLast(tab));
    else turn.fail((e && e.message) || String(e), () => retryLast(tab));
  }
  turn.done(); // stream closed - freeze the working-trace summary to its final step count
  // An agent turn is not a chat message - it can run for minutes while the operator does something
  // else. Tell them it landed, but only if they actually left: notifyOperator says nothing while
  // BuildEx has focus, because the answer is already on their screen.
  if (typeof notifyOperator === "function") {
    notifyOperator("chat", {
      title: tab.title && tab.title !== "New chat" ? tab.title : "BuildEx",
      body: "Your answer is ready.",
      tag: "chat-" + tab.sessionId,
      onClick: () => activateTab(tab.id),
    });
  }
  tab.abort = null;
  syncBusy = Math.max(0, syncBusy - 1);
  if (!syncBusy) setSync("ok");
  tab.busy = false;
  tab.status = "idle";
  tab.composer.setBusy(false);
  renderTabbar();
  if (tab.title === "New chat") {
    tab.title = chatTitle(prompt);
    renderTabbar();
  }
  refreshPending();
  refreshProjects();
}

/**
 * A tab title from the operator's first message: the first sentence, cut at a word boundary rather
 * than mid-word, with markdown noise stripped. (The daemon titles the stored session the same way.)
 * @param {string} prompt - the first message.
 * @returns {string} a short title.
 */
function chatTitle(prompt) {
  const clean = String(prompt || "")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = clean.split(/(?<=[.!?])\s/)[0] || clean;
  if (sentence.length <= 34) return sentence || "New chat";
  const cut = sentence.slice(0, 34);
  const space = cut.lastIndexOf(" ");
  return (space > 14 ? cut.slice(0, space) : cut) + "…";
}
