"use strict";
// Pending approval cards (the human gate surface).
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Renders the outward-action approval queue from /api/pending, keeps the title-bar badge in sync,
// and posts approve/deny verdicts back. Reads `S.rightTab` to know when the pending view is showing.

/**
 * Fetch the pending cards and render them (treating any error as an empty queue).
 * @returns {Promise<void>}
 */
async function rPending() {
  renderPending(
    await getJSON("/api/pending")
      .then((d) => d.cards)
      .catch(() => []),
  );
}

/**
 * Turn a raw tool invocation into a human-readable one-line summary of the outward action, so the
 * approval card reads like a sentence a non-technical operator can judge - never raw JSON. Connector
 * actions carry their own `summary` (the gateway writes one); everything else gets a per-tool phrasing.
 * @param {string} name - the tool name (e.g. "Skill", "WebFetch", "mcp:gmail.send").
 * @param {object} input - the tool input object.
 * @returns {{ line: string, command: (string|null) }} `line` is the summary; `command` is a shell
 *   command to show in a code chip (Bash only), else null.
 */
function humanizeCard(name, input) {
  const inp = input && typeof input === "object" ? input : {};
  const args = inp.args && typeof inp.args === "object" ? inp.args : {};
  // A connector/gateway action ships its own human summary - always prefer it.
  if (typeof inp.summary === "string" && inp.summary.trim()) return { line: inp.summary.trim(), command: null };
  // An email/Gmail send: name it by recipient. Matches the connector shape (`mcp:gmail.send`,
  // input.tool === "send") and any plain send-tool that carries a recipient.
  const recipient = args.to || inp.to || inp.recipient || args.recipient;
  const looksLikeSend = /gmail|mail|email/i.test(name) || inp.tool === "send" || (recipient && /send/i.test(name));
  if (looksLikeSend && recipient) return { line: "Send email to " + recipient, command: null };
  // Run a skill.
  if (name === "Skill" || inp.skill) return { line: "Run the " + (inp.skill || "requested") + " skill", command: null };
  // Fetch a URL - show just the domain.
  if (name === "WebFetch" || inp.url) {
    let host = String(inp.url || "");
    try { host = new URL(inp.url).hostname; } catch (e) { /* keep the raw string */ }
    return { line: "Fetch " + (host || "a web page"), command: null };
  }
  // Web search.
  if (name === "WebSearch" || inp.query) return { line: 'Search the web for "' + inp.query + '"', command: null };
  // A shell command - phrase it and surface the command itself in a code chip.
  if (name === "Bash" || typeof inp.command === "string") return { line: "Run a shell command", command: inp.command || "" };
  // Fallback: the tool name, which is still human-legible for named tools.
  return { line: name + " - approval needed", command: null };
}

/**
 * Render the approval cards into the right panel — but only while the "pending" tab is active.
 * @param {Array<object>} cards - pending approval cards from the daemon.
 */
function renderPending(cards) {
  if (S.rightTab !== "pending") return;
  const p = $("#rpanel");
  // Built with el() (the safe DOM builder, dom.js) - text is set via textContent and clicks are wired
  // inline, so a tool name/input can never inject markup (this is the reference surface
  // for the innerHTML→builder migration, pinned by console-render.test.ts).
  // a11y: the tray is a live region so a screen reader announces a new approval card the moment
  // it arrives - the human gate (invariant 5) must be perceivable, not just visible. The approve/deny
  // buttons are named per tool so their purpose is clear out of visual context.
  p.replaceChildren(
    el("h4", { text: "Pending - outward actions wait for you" }),
    el("div", { id: "rl", role: "region", "aria-label": "Pending approvals", "aria-live": "polite" }),
  );
  const host = $("#rl");
  if (!cards.length) {
    host.appendChild(el("div", { class: "rmini" }, el("div", { class: "big", "aria-hidden": "true", text: "✓" }), "All caught up."));
    return;
  }
  cards.forEach((c) => {
    const name = (c.tool && c.tool.name) || "action";
    const rawInput = (c.tool && c.tool.input) || null;
    const { line, command } = humanizeCard(name, rawInput || {});
    // The raw request stays available - folded into a collapsed <details> so a curious operator can
    // inspect exactly what the agent asked for, without the card body reading as JSON.
    const raw = rawInput ? JSON.stringify(rawInput, null, 2) : "";
    host.appendChild(
      el(
        "div",
        { class: "pcard", role: "group", "aria-label": name + " - approval needed" },
        el(
          "div",
          { class: "pt" },
          el("span", { class: "tag", text: name }),
          el("div", { class: "pw", text: line }),
          command ? el("div", { class: "pcmd" }, el("code", { text: command })) : null,
          raw
            ? el(
                "details",
                { class: "pd" },
                el("summary", { text: "Show request" }),
                el("pre", { text: raw }),
              )
            : null,
        ),
        el(
          "div",
          { class: "pa" },
          el("button", { class: "approve", text: "Approve", "aria-label": "Approve " + name, onClick: () => resolveCard(c.id, "approve") }),
          el("button", { class: "dny", text: "Deny", "aria-label": "Deny " + name, onClick: () => resolveCard(c.id, "deny") }),
        ),
      ),
    );
  });
}

/**
 * Refresh the title-bar badge count and, if the pending view is open, re-render its cards.
 * @returns {Promise<void>}
 */
async function refreshPending() {
  let cards;
  try {
    cards = (await getJSON("/api/pending")).cards;
  } catch (e) {
    return;
  }
  const b = $("#pbadge");
  if (cards.length) {
    b.style.display = "";
    b.textContent = cards.length;
  } else b.style.display = "none";
  if (S.rightTab === "pending") renderPending(cards);
}

/**
 * Post an approve/deny verdict for one card, then refresh the badge/queue.
 * @param {string} id - the card id.
 * @param {"approve"|"deny"} verdict - the operator's decision.
 * @returns {Promise<void>}
 */
async function resolveCard(id, verdict) {
  await postJSON("/api/approve", { id, verdict });
  refreshPending();
}
