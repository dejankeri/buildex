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

// The last /api/sync response, so the tray can paint the save card immediately (and the approvals
// with it) while a fresh count is still being read off disk. null until the first one lands.
let lastSync = null;

// The last /api/conflicts response - the kept-work backups still waiting on the operator. Kept
// current by the same 4s poll as the save card; boot.js reads it to route the "needs attention"
// dot click into this tray (the card IS the recovery surface) rather than the change log.
let lastConflicts = [];

// One pinned card above the approvals. Sending work to the company is an outward action, so this is
// the right tray for it (invariant 5) - but it is a single action with no decline, so it is shaped
// differently from the Approve/Deny pairs.
function saveCardHtml(sync, connected, signInAvailable) {
  const n = sync.unsaved.files;
  if (n === 0) return "";
  const noun = n === 1 ? "change" : "changes";
  const are = n === 1 ? "is" : "are"; // subject-verb agreement for the singular "1 change" case
  const have = n === 1 ? "hasn't" : "haven't";
  const stale = sync.unsaved.stale;
  const days = stale ? Math.max(1, Math.round((Date.now() - sync.unsaved.oldestAt) / DAY_MS)) : 0;

  // No account yet: there is nowhere to save TO automatically. When sign-in IS available (js/signin.js
  // is wired to a real Supabase config), this card offers a real next step instead of stating the fact
  // and stopping. "connected" here still means "an account exists to save to", so the card reads as a
  // straightforward context: this work is local, and signing in would fix that.
  if (!connected && signInAvailable) {
    return (
      '<div class="pcard save signin' + (stale ? " stale" : "") + '">' +
      "<b>Your work only lives on this machine</b>" +
      "<p>" + n + " " + noun + " " + are + " saved here and nowhere else. Sign in free to back " +
      (n === 1 ? "it" : "them") + " up." +
      "</p>" +
      '<button class="pbtn" id="signin-now" type="button">Sign in</button>' +
      "</div>"
    );
  }
  // No account yet, and sign-in is dormant (not configured) - there is no working next step to
  // offer, so this is purely informational: the fact that work is local, nothing more. No "Sign in"
  // button, no sign-in language - it would dead-end at a 501.
  if (!connected) {
    return (
      '<div class="pcard save' + (stale ? " stale" : "") + '">' +
      "<b>Your work only lives on this machine</b>" +
      "<p>" + n + " " + noun + " " + are + " saved here and nowhere else.</p>" +
      "</div>"
    );
  }
  const line = stale
    ? "This work has been on this machine for " + days + " day" + (days === 1 ? "" : "s") +
      ". It exists nowhere else."
    : n + " " + noun + " on this machine " + have + " been saved to your company yet.";
  // The save's name, prefilled with the daemon's suggestion. The suggestion is derived from FILE
  // NAMES - workspace data an agent can write, so attacker-influenceable - and must only ever land
  // through escAttr, never as markup.
  const suggestion = sync.unsaved.suggestion || "";
  return (
    '<div class="pcard save' + (stale ? " stale" : "") + '">' +
    "<b>Save your work</b>" +
    "<p>" + line + "</p>" +
    '<input class="savemsg" id="save-msg" type="text" maxlength="120" ' +
    'placeholder="Name this save" aria-label="Name this save" value="' + escAttr(suggestion) + '">' +
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
  const [cards, sync, kept] = await Promise.all([
    getJSON("/api/pending").then((d) => d.cards).catch(() => []),
    getJSON("/api/sync").catch(() => null),
    getJSON("/api/conflicts").then((d) => d.conflicts).catch(() => null),
  ]);
  if (sync) lastSync = sync;
  if (kept) lastConflicts = kept;
  renderPending(cards, sync, kept);
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
 * Render the save card + kept-work cards + approval cards into the right panel — but only while
 * the "pending" tab is active.
 * @param {Array<object>} cards - pending approval cards from the daemon.
 * @param {object|null} sync - the `/api/sync` response (null if the fetch failed).
 * @param {Array<object>|null} [kept] - the `/api/conflicts` response (falls back to the cached one).
 */
function renderPending(cards, sync, kept) {
  if (S.rightTab !== "pending") return;
  const p = $("#rpanel");
  // The tray re-renders on every 4s poll, which would wipe a save name the operator is mid-typing.
  // Capture their edit (a value that differs from the prefill it was rendered with) plus focus and
  // caret before rebuilding, and put all three back after.
  const prevMsg = $("#save-msg");
  const typedMsg = prevMsg && prevMsg.value !== prevMsg.defaultValue ? prevMsg.value : null;
  const msgFocused = !!prevMsg && document.activeElement === prevMsg;
  const msgCaret = msgFocused ? [prevMsg.selectionStart, prevMsg.selectionEnd] : null;
  // Built with el() (the safe DOM builder, dom.js) - text is set via textContent and clicks are wired
  // inline, so a tool name/input can never inject markup (this is the reference surface
  // for the innerHTML→builder migration, pinned by console-render.test.ts). The save card's markup
  // (saveCardHtml) interpolates only numbers computed from the daemon's response - plus the save-name
  // suggestion, which is agent-influenceable and therefore goes through escAttr - so it's safe to
  // hand to el()'s `html` escape hatch.
  // a11y: the tray is a live region so a screen reader announces a new approval card the moment
  // it arrives - the human gate (invariant 5) must be perceivable, not just visible. The approve/deny
  // buttons are named per tool so their purpose is clear out of visual context.
  // Connectivity comes from the daemon's view of the repositories (`unsaved.connected`), never from
  // `sync.status` - that field starts at "ok" and only moves when the operator saves, so it says
  // "connected" on a fresh install that has no account at all.
  const saveHtml = sync ? saveCardHtml(sync, !!(sync.unsaved && sync.unsaved.connected), !!sync.signInAvailable) : "";
  const kids = [];
  if (saveHtml) kids.push(el("div", { id: "savecard", html: saveHtml }));
  // Kept-work cards, pinned beside the save card: one per backup, built with el() throughout -
  // the file names (and, in the compare view, the content) come from workspace files an agent can
  // write, so they are attacker-influenceable and must only ever land as text, never markup.
  ((kept || lastConflicts) || []).forEach((k) => kids.push(keptCard(k)));
  kids.push(
    el("h4", { text: "Pending - outward actions wait for you" }),
    el("div", { id: "rl", role: "region", "aria-label": "Pending approvals", "aria-live": "polite" }),
  );
  p.replaceChildren(...kids);
  const msgNow = $("#save-msg");
  if (msgNow && typedMsg !== null) msgNow.value = typedMsg;
  if (msgNow && msgFocused) {
    msgNow.focus();
    if (msgCaret && msgCaret[0] != null) msgNow.setSelectionRange(msgCaret[0], msgCaret[1]);
  }
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
  // Both requests fire together (not one-then-the-other) so the render below waits on the slower
  // of the two, not their sum - the human gate still isn't held up by counting unsaved work, it just
  // no longer needs a second, separate render to fold that count in.
  const cardsP = getJSON("/api/pending").then((d) => d.cards).catch(() => null);
  const syncP = getJSON("/api/sync").catch(() => null);
  const keptP = getJSON("/api/conflicts").then((d) => d.conflicts).catch(() => null);
  const cards = await cardsP;
  if (cards === null) return;
  const b = $("#pbadge");
  if (cards.length) {
    b.style.display = "";
    b.textContent = cards.length;
  } else b.style.display = "none";
  // The Gate lives in the Brain map now. Refresh the map only when the pending SET actually changes
  // (by id, so swapping one card for another at the same count still repaints) - a full repaint every
  // tick would flicker the star and reset the scroll for nothing.
  if (S.rightTab === "brain" && S.brain) {
    const sig = (l) => (l || []).map((c) => c && c.id).join("|");
    if (sig(S.brain.pend) !== sig(cards)) rBrain();
  }
  const sync = await syncP;
  if (sync) lastSync = sync;
  const kept = await keptP;
  if (kept) lastConflicts = kept;
  // Render exactly once per poll. Rendering twice (once from cached lastSync, once from the fresh
  // fetch) rebuilt the whole tray twice on every tick - including a Save button that was mid-POST,
  // which reset it back to its idle label out from under the operator's own click.
  if (S.rightTab === "pending") renderPending(cards, sync || lastSync, kept || lastConflicts);
}

/**
 * Wire the save card's button (present only when there is somewhere to save to): post the save -
 * named by the message input, prefilled with the daemon's suggestion - and re-render. A failure
 * restores the button rather than leaving it stuck on "Saving…" - the operator must always be able
 * to try again.
 */
function wireSaveCard() {
  const saveBtn = $("#save-now");
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const label = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      const msgInput = $("#save-msg");
      const message = msgInput && msgInput.value.trim() ? msgInput.value.trim() : "";
      try {
        await postJSON("/api/sync", message ? { message: message } : {});
      } catch (e) {
        // The save never reached the daemon. Leave the card exactly as it was, with a working
        // button - re-rendering here would drop the card on the failed poll that follows.
        saveBtn.disabled = false;
        saveBtn.textContent = label;
        return;
      }
      rPending(); // re-render: the count is now zero, or the failure shows in the dot
    };
  }
  // The not-connected variant of the same card (js/pending.js's saveCardHtml) - same tray, same
  // idiom, but there is nowhere to save TO yet, so the button opens the sign-in modal instead.
  const signinBtn = $("#signin-now");
  if (signinBtn) signinBtn.onclick = () => startSignIn();
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

// --- Kept-work cards --------------------------------------------------------------------------
// When two machines change the same document, the daemon keeps the operator's version and lets the
// team's win; these cards are how the operator gets theirs back. Vocabulary is theirs, not git's:
// "we kept your version" / "the team's version won" - never conflict/merge/rebase. Every string
// that reaches the DOM here goes through el()'s textContent path: file names and file content are
// workspace data an agent can write, so they must render as inert text.

/**
 * The card's explanatory line, phrased by how much is still waiting to be brought back.
 * @param {object} k - one `/api/conflicts` backup ({root, stamp, at, files}).
 * @param {number} left - how many files still differ from the current version.
 * @returns {string}
 */
function keptLine(k, left) {
  const when = k.at ? ago(k.at) : "";
  const won = "The team's version won" + (when && when !== "now" ? " " + when + " ago" : " just now") + ".";
  if (left === 0) return won + " Everything here now matches your current files - nothing left to copy back.";
  const yours = k.files.length === 1 ? "Yours is safe here" : "Yours are safe here";
  return won + " " + yours + " - compare the two, or copy yours back.";
}

/**
 * One kept file's row: the name, a View (side-by-side) action, and Copy back while the kept bytes
 * still differ from the current file.
 * @param {object} k - the backup the file belongs to.
 * @param {object} f - one file entry ({path, differs}).
 * @returns {HTMLElement}
 */
function keptFileRow(k, f) {
  return el(
    "div",
    { class: "kfile" },
    el("span", { class: "kname", text: f.path, title: f.path }),
    el(
      "span",
      { class: "ka" },
      el("button", { class: "mini ghost", text: "View", "aria-label": "View your kept version of " + f.path, onClick: () => viewKept(k.root, k.stamp, f.path) }),
      f.differs
        ? el("button", { class: "mini", text: "Copy back", "aria-label": "Copy your version of " + f.path + " back", onClick: () => copyBackKept(k.root, k.stamp, f.path) })
        : el("span", { class: "kdone", text: "Same as current" }),
    ),
  );
}

/**
 * One backup's card: "We kept your version of …" with per-file View / Copy back, and - once
 * nothing differs any more - a Dismiss that clears the card (the kept copy stays on disk).
 * @param {object} k - one `/api/conflicts` backup.
 * @returns {HTMLElement}
 */
function keptCard(k) {
  const files = k.files || [];
  const what = files.length === 1 ? (files[0].path.split("/").pop() || files[0].path) : files.length + " files";
  const left = files.filter((f) => f.differs).length;
  return el(
    "div",
    { class: "pcard kept", role: "group", "aria-label": "Your kept work" },
    el("b", { text: "We kept your version of " + what }),
    el("p", { text: keptLine(k, left) }),
    el("div", { class: "kfiles" }, files.map((f) => keptFileRow(k, f))),
    left === 0
      ? el("button", { class: "mini ghost kdismiss", text: "Got it", onClick: () => dismissKept(k.root, k.stamp) })
      : null,
  );
}

/**
 * Open the read-only side-by-side look at one kept file: your version next to the current one, on
 * the console's own overlay (same idiom as confirmAction - Esc, the backdrop, and Close all leave
 * everything untouched). Content lands via textContent only.
 * @param {string} root - the repo the file lives in.
 * @param {string} stamp - the backup's stamp.
 * @param {string} file - the repo-relative file path.
 * @returns {Promise<void>}
 */
async function viewKept(root, stamp, file) {
  let d;
  try {
    d = await getJSON(
      "/api/conflicts/file?root=" + encodeURIComponent(root) + "&stamp=" + encodeURIComponent(stamp) + "&file=" + encodeURIComponent(file),
    );
  } catch (e) {
    toast("Couldn't open your kept version", true);
    return;
  }
  const bd = el("div", { class: "ovbackdrop" });
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
  bd.appendChild(
    el(
      "div",
      { class: "ovcard kview" },
      el("h3", { class: "ovh", text: file }),
      el(
        "div",
        { class: "kpanes" },
        el("div", { class: "kpane" }, el("h4", { text: "Your version (kept)" }), el("pre", { text: d.kept })),
        el(
          "div",
          { class: "kpane" },
          el("h4", { text: "Current version" }),
          el("pre", { text: d.current == null ? "(this file no longer exists)" : d.current }),
        ),
      ),
      el("div", { class: "ovrow" }, el("button", { class: "mini ghost ovno", text: "Close", onClick: close })),
    ),
  );
  document.body.appendChild(bd);
}

/**
 * Copy the kept version back over the current file. An ordinary edit on the daemon side - it saves
 * like any other change - so no confirmation is needed: nothing is destroyed, and the team's
 * version stays in history. Re-renders the tray so the row flips to "Same as current".
 * @param {string} root
 * @param {string} stamp
 * @param {string} file
 * @returns {Promise<void>}
 */
async function copyBackKept(root, stamp, file) {
  try {
    const r = await postJSON("/api/conflicts/restore", { root: root, stamp: stamp, file: file });
    if (r && r.error) throw new Error(r.error);
  } catch (e) {
    toast("Couldn't copy your version back", true);
    return;
  }
  rPending();
}

/**
 * Clear one kept-work card (the operator has decided). Only the attention flag goes; the kept copy
 * itself stays on disk, so this is never a "delete".
 * @param {string} root
 * @param {string} stamp
 * @returns {Promise<void>}
 */
async function dismissKept(root, stamp) {
  try {
    const r = await postJSON("/api/conflicts/dismiss", { root: root, stamp: stamp });
    if (r && r.error) throw new Error(r.error);
  } catch (e) {
    toast("Couldn't clear the card", true);
    return;
  }
  rPending();
}
