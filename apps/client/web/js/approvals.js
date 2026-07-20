"use strict";
// Inline chat approvals: one EventSource carries the daemon's live approval feed, and each event is
// routed to the chat whose session raised it — rendering an Approve/Deny card right in that thread
// (the agent is paused on it). The right-rail Pending tray still lists every card (retired in ③).
//
// Part of the operator console (web/index.html). Classic script — loaded in order via <script src>,
// sharing one global scope. NOT an ES module. Uses globals: S, el, humanizeCard, postJSON,
// refreshPending, esc.

// Inline card nodes we've rendered, keyed by card id, so a later "resolve" event finalizes the one node.
const _inlineApprovals = {};

/** The open chat tab for a BuildEx session id (the tab holds a `.thread`), or undefined. */
function _tabForSession(sessionId) {
  if (!sessionId) return undefined;
  return S.tabs.find((t) => t.sessionId === sessionId && t.thread);
}

/**
 * Render an inline Approve/Deny card into a chat tab's thread. Idempotent per card id.
 * @param {object} tab - the chat tab (must have `.thread`).
 * @param {object} card - the approval card ({ id, tool:{name,input}, origin }).
 */
function injectApproval(tab, card) {
  if (!tab || !tab.thread || _inlineApprovals[card.id]) return;
  const name = (card.tool && card.tool.name) || "action";
  const input = (card.tool && card.tool.input) || {};
  const { line, command } = humanizeCard(name, input);
  const node = el(
    "div",
    { class: "approval", role: "group", "aria-label": name + " - approval needed", "aria-live": "polite" },
    el(
      "div",
      { class: "ap-head" },
      el("span", { class: "ap-ic", "aria-hidden": "true", text: "⏸" }),
      el("div", { class: "ap-line", text: line }),
    ),
    command ? el("div", { class: "ap-cmd" }, el("code", { text: command })) : null,
    el(
      "div",
      { class: "ap-actions" },
      el("button", { class: "approve", text: "Approve", "aria-label": "Approve " + name, onClick: () => _resolveInline(card.id, "approve") }),
      el("button", { class: "dny", text: "Deny", "aria-label": "Deny " + name, onClick: () => _resolveInline(card.id, "deny") }),
    ),
  );
  tab.thread.appendChild(node);
  tab.thread.scrollTop = tab.thread.scrollHeight;
  _inlineApprovals[card.id] = node;
}

/**
 * Post the operator's verdict for an inline card, then let the SSE "resolve" event finalize the visual
 * state (the same event fires whether approved here, from the tray, or by the TTL auto-deny).
 * @param {string} id - card id.
 * @param {"approve"|"deny"} verdict - the decision.
 */
async function _resolveInline(id, verdict) {
  const node = _inlineApprovals[id];
  if (node) node.querySelectorAll("button").forEach((b) => (b.disabled = true)); // optimistic lock
  try {
    await postJSON("/api/approve", { id, verdict });
  } catch (e) {
    if (node) node.querySelectorAll("button").forEach((b) => (b.disabled = false)); // let them retry
    return;
  }
  if (typeof refreshPending === "function") refreshPending(); // keep the tray badge in step
}

/**
 * Finalize an already-rendered inline card once it resolves (from anywhere): lock its buttons and
 * show the verdict. A no-op if this session never rendered the card (it was for another chat/the tray).
 * @param {string} id - card id.
 * @param {"approve"|"deny"} verdict - the decision that landed.
 */
function _finalizeApproval(id, verdict) {
  const node = _inlineApprovals[id];
  if (!node) return;
  node.classList.add(verdict === "approve" ? "ap-approved" : "ap-denied");
  node.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const line = node.querySelector(".ap-line");
  if (line) line.appendChild(el("span", { class: "ap-verdict", text: verdict === "approve" ? " · approved" : " · denied" }));
}

/**
 * Open the live approvals feed and route each event to the right chat. EventSource reconnects on its
 * own; the daemon replays open cards on (re)connect so nothing is missed. Safe to call once at boot.
 */
function startApprovals() {
  if (typeof EventSource === "undefined") return; // non-browser (e.g. jsdom smoke) - nothing to stream
  let es;
  try {
    es = new EventSource("/api/approvals/stream");
  } catch (e) {
    return;
  }
  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch (x) {
      return;
    }
    if (ev.type === "open" && ev.card) {
      const tab = _tabForSession(ev.card.origin && ev.card.origin.sessionId);
      if (tab) injectApproval(tab, ev.card);
    } else if (ev.type === "resolve") {
      _finalizeApproval(ev.id, ev.verdict);
    }
  };
}
