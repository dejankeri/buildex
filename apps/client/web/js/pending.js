"use strict";
// Pending approval cards (the human gate surface).
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Renders the outward-action approval queue from /api/pending, keeps the title-bar badge in sync,
// and posts approve/deny verdicts back. Reads `S.rightTab` to know when the pending view is showing.
// Also renders the save card from /api/sync - the operator's one manual control over sending local
// work to the company (invariant 1: the cloud syncs, never thinks).

const DAY_MS = 86400000;

// One pinned card above the approvals. Sending work to the company is an outward action, so this is
// the right tray for it (invariant 5) - but it is a single action with no decline, so it is shaped
// differently from the Approve/Deny pairs.
function saveCardHtml(sync, connected) {
  const n = sync.unsaved.files;
  if (n === 0) return "";
  const noun = n === 1 ? "change" : "changes";
  const are = n === 1 ? "is" : "are"; // subject-verb agreement for the singular "1 change" case
  const have = n === 1 ? "hasn't" : "haven't";
  const stale = sync.unsaved.stale;
  const days = stale ? Math.max(1, Math.round((Date.now() - sync.unsaved.oldestAt) / DAY_MS)) : 0;

  if (!connected) {
    return (
      '<div class="pcard save' + (stale ? " stale" : "") + '">' +
      "<b>Save your work</b>" +
      "<p>" + n + " " + noun + " " + are + " staying on this machine. Connect an account to keep them safe." +
      "</p>" +
      '<button class="pbtn" id="save-now" data-connect="1">Connect an account</button>' +
      "</div>"
    );
  }
  const line = stale
    ? "This work has been on this machine for " + days + " day" + (days === 1 ? "" : "s") +
      ". It exists nowhere else."
    : n + " " + noun + " on this machine " + have + " been saved to your company yet.";
  return (
    '<div class="pcard save' + (stale ? " stale" : "") + '">' +
    "<b>Save your work</b>" +
    "<p>" + line + "</p>" +
    '<button class="pbtn" id="save-now">Save now</button>' +
    "</div>"
  );
}

/**
 * Fetch the pending cards + sync state and render them (treating any error as an empty/absent
 * result, so a daemon hiccup shows an empty tray rather than throwing).
 * @returns {Promise<void>}
 */
async function rPending() {
  const [cards, sync] = await Promise.all([
    getJSON("/api/pending").then((d) => d.cards).catch(() => []),
    getJSON("/api/sync").catch(() => null),
  ]);
  renderPending(cards, sync);
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
 * Render the save card + approval cards into the right panel — but only while the "pending" tab is
 * active.
 * @param {Array<object>} cards - pending approval cards from the daemon.
 * @param {object|null} sync - the `/api/sync` response (null if the fetch failed).
 */
function renderPending(cards, sync) {
  if (S.rightTab !== "pending") return;
  const p = $("#rpanel");
  // Built with el() (the safe DOM builder, dom.js) - text is set via textContent and clicks are wired
  // inline, so a tool name/input can never inject markup (this is the reference surface
  // for the innerHTML→builder migration, pinned by console-render.test.ts). The save card's markup
  // (saveCardHtml) interpolates only numbers computed from the daemon's response, never
  // operator/agent-supplied strings, so it's safe to hand to el()'s `html` escape hatch.
  // a11y: the tray is a live region so a screen reader announces a new approval card the moment
  // it arrives - the human gate (invariant 5) must be perceivable, not just visible. The approve/deny
  // buttons are named per tool so their purpose is clear out of visual context.
  const saveHtml = sync ? saveCardHtml(sync, sync.status !== "local") : "";
  const kids = [];
  if (saveHtml) kids.push(el("div", { id: "savecard", html: saveHtml }));
  kids.push(
    el("h4", { text: "Pending - outward actions wait for you" }),
    el("div", { id: "rl", role: "region", "aria-label": "Pending approvals", "aria-live": "polite" }),
  );
  p.replaceChildren(...kids);
  wireSaveCard();
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
 * Refresh the title-bar badge count and, if the pending view is open, re-render its cards + the
 * save card (also polled here, on the same 4s interval, so unsaved work shows up without the
 * operator having to switch tabs).
 * @returns {Promise<void>}
 */
async function refreshPending() {
  let cards;
  try {
    cards = (await getJSON("/api/pending")).cards;
  } catch (e) {
    return;
  }
  const sync = await getJSON("/api/sync").catch(() => null);
  const b = $("#pbadge");
  if (cards.length) {
    b.style.display = "";
    b.textContent = cards.length;
  } else b.style.display = "none";
  if (S.rightTab === "pending") renderPending(cards, sync);
}

/**
 * Wire the save card's button (if present): "Connect an account" routes to setup; otherwise it
 * posts the save and re-renders (the count then reads zero, or a failure shows up in the dot).
 */
function wireSaveCard() {
  const saveBtn = $("#save-now");
  if (saveBtn) {
    saveBtn.onclick = async () => {
      if (saveBtn.dataset.connect) return switchRight("apps"); // no account yet - send them to setup
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        await fetch("/api/sync", { method: "POST" });
      } finally {
        rPending(); // re-render: the count is now zero, or the failure shows in the dot
      }
    };
  }
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
