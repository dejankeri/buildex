"use strict";
// The Loops panel — the right-rail surface for work the operator has scheduled to run on its own.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via <script src>,
// sharing one global scope. NOT an ES module.
//
// Built entirely with el() (the safe DOM builder, dom.js): every string here is operator- or
// agent-supplied — a loop title, a prompt, the action a run was blocked on — so it goes through
// textContent, never innerHTML. Pinned by console-render-loops.test.ts.
//
// The daemon owns every derived string: the schedule sentence ("every Monday at 9:00 AM") and the
// status both arrive computed on /api/loops, so there is exactly one phrasing of a schedule in the
// product and this file never re-implements the clock.

/** Suggestions the empty state offers. They pre-fill the composer; they never create anything. */
const LOOP_SUGGESTIONS = [
  { title: "Monday update", prompt: "Read last week's activity log and draft the Monday update.", at: "09:00", days: "mon" },
  { title: "Inbox sweep", prompt: "Go through the inbox, draft replies to anything routine, and list what needs me.", every: "2h" },
  { title: "End of day", prompt: "Summarise what changed today and what is waiting on someone.", at: "17:30" },
];

/** Render the Loops panel: header, a card per loop (or the empty state), and the composer host. */
async function rLoops() {
  const p = $("#rpanel");
  p.innerHTML = "";
  p.append(
    el(
      "div",
      { class: "rhead" },
      el("h4", { text: "Loops" }),
      el("button", { class: "radd", id: "newLoop", text: "+ New loop", onClick: () => openLoopComposer() }),
    ),
    el("div", { id: "loopspend" }),
    el("div", { id: "loopcomposer" }),
    el("div", { id: "looplist" }),
  );
  await refreshLoops();
}

/** Fetch loops into `S.loops` and repaint the list (and the tab badge). */
async function refreshLoops() {
  const before = S.loops;
  try {
    const r = await getJSON("/api/loops");
    S.loops = r.loops || [];
    S.loopSpend = r.spend || null;
  } catch (e) {
    S.loops = [];
  }
  noticeLoopChanges(before, S.loops);
  renderLoopBadge();
  if (S.rightTab === "loops") {
    renderLoopSpend();
    renderLoopList();
  }
}

/**
 * Tell the operator about a run that ended needing them, or failed — the whole point of polling this
 * when the panel is closed. Only TRANSITIONS count: a loop that was already blocked when we last
 * looked is old news, and re-announcing it on every poll is how an app earns a permanent mute.
 * A loop seen for the first time is skipped too, so a page reload does not replay yesterday.
 * @param {Array|undefined} before - the previous /api/loops rows (undefined on the first fetch).
 * @param {Array} after - the rows just fetched.
 */
function noticeLoopChanges(before, after) {
  if (!before || typeof notifyOperator !== "function") return;
  const prev = new Map(before.map((l) => [l.name, l]));
  for (const loop of after || []) {
    const was = prev.get(loop.name);
    if (!was || (was.status === loop.status && was.lastRun === loop.lastRun)) continue;
    const open = () => {
      switchRight("loops");
      if (loop.sessionId) openChatTab({ id: loop.sessionId, title: loop.title, status: "idle" });
    };
    if (loop.status === "needs-approval") {
      notifyOperator("loops", {
        title: loop.title + " needs you",
        body: loop.blockedOn ? "It tried to " + loop.blockedOn + "." : "It stopped for your approval.",
        tag: "loop-" + loop.name,
        onClick: open,
        whenFocused: "toast",
      });
    } else if (loop.status === "failed") {
      notifyOperator("loops", {
        title: loop.title + " failed",
        body: "The run did not finish. Open it to see how far it got.",
        tag: "loop-" + loop.name,
        onClick: open,
        whenFocused: "toast",
      });
    }
  }
}

/** The spend line above the list: what loops have cost on this machine, and their daily ceiling. */
function renderLoopSpend() {
  const host = $("#loopspend");
  if (!host) return;
  host.innerHTML = "";
  const spend = S.loopSpend;
  if (!spend || (!spend.month.runs && spend.capUsd === undefined)) return; // nothing has run, nothing to say

  if (spend.overCap) {
    // Not a footnote: the scheduler is deliberately not firing, and an operator who is not told that
    // will read it as broken. Says what happens next, and offers the one control that changes it.
    host.append(
      el(
        "div",
        { class: "loopcap over" },
        el("span", { class: "lc-tx", text: "Loops are paused — this machine has spent its " + usd(spend.capUsd) + " for today. They start again after midnight." }),
        el("button", { class: "mini ghost lc-edit", text: "Change limit", onClick: () => openLoopBudget() }),
      ),
    );
    return;
  }
  host.append(
    el(
      "div",
      { class: "loopcap" },
      el("span", {
        class: "lc-tx",
        text:
          spend.capUsd === undefined
            ? "About " + usd(spend.today.costUsd) + " today · " + usd(spend.month.costUsd) + " this month"
            : "About " + usd(spend.today.costUsd) + " of " + usd(spend.capUsd) + " today",
      }),
      el("button", {
        class: "mini ghost lc-edit",
        text: spend.capUsd === undefined ? "Set a limit" : "Change",
        onClick: () => openLoopBudget(),
      }),
    ),
  );
}

/**
 * Money, the way the operator reads it. Loop runs are routinely fractions of a cent, so a bare
 * round-to-cents would show "$0.00" for real spending — say "under $0.01" instead of lying.
 * @param {number} n - USD.
 * @returns {string}
 */
function usd(n) {
  const v = Number(n) || 0;
  if (v > 0 && v < 0.01) return "under $0.01";
  return "$" + v.toFixed(2);
}

/** Paint the list of loop cards, or the empty state when there are none. */
function renderLoopList() {
  const host = $("#looplist");
  if (!host) return;
  host.innerHTML = "";
  const loops = S.loops || [];
  if (!loops.length) {
    host.append(loopEmptyState());
    return;
  }
  // Offered here, where the lack is felt, and only until the operator answers one way or the other.
  const nudge = typeof notifyNudge === "function" ? notifyNudge() : null;
  if (nudge) host.append(nudge);
  for (const loop of loops) host.append(loopCard(loop));
}

/** The empty state: what a loop is, in one line, plus suggestions that open the composer filled in. */
function loopEmptyState() {
  return el(
    "div",
    { class: "rmini loopempty" },
    el("div", { class: "big", text: "↻" }),
    el("div", { text: "Nothing scheduled yet. A loop runs a prompt on its own — every few hours, or at a time you pick." }),
    el(
      "div",
      { class: "loopsugs" },
      LOOP_SUGGESTIONS.map((s) =>
        el("button", { class: "mini ghost", text: s.title, onClick: () => openLoopComposer(s) }),
      ),
    ),
  );
}

/**
 * One loop card: what it does, when it runs next, and how the last run went.
 * @param {object} loop - a row from /api/loops.
 * @returns {HTMLElement}
 */
function loopCard(loop) {
  const running = loop.status === "running";
  const card = el(
    "div",
    { class: "rcard loopcard" + (loop.enabled && loop.activeHere ? "" : " off"), dataset: { loop: loop.name } },
    el(
      "div",
      { class: "cn" },
      el("span", { class: "loopglyph", "aria-hidden": "true", text: "↻" }),
      el("span", { class: "loopt", text: loop.title }),
      loopStatusChip(loop),
    ),
    el("div", { class: "cd loopbody", text: loop.prompt || "Runs the " + (loop.verb || "?") + " verb" }),
    el(
      "div",
      { class: "cd loopwhen" },
      el("span", { class: "loopsched", text: loop.scheduleText }),
      el("span", { class: "loopsep", "aria-hidden": "true", text: "·" }),
      el("span", { class: "loopnext", text: loopWhenText(loop) }),
    ),
    loopRunStrip(loop),
    loop.blockedOn
      // The chip already says WHY it stopped ("Needed you"); this line says WHAT it wanted to do,
      // so the two are not the same sentence twice.
      ? el("div", { class: "loopblocked", text: "It tried to " + loop.blockedOn + ". Run it now to approve." })
      : null,
    el(
      "div",
      { class: "ra" },
      el("button", {
        class: "mini run",
        text: running ? "Running…" : "Run now",
        disabled: running || undefined,
        onClick: () => runLoopNow(loop),
      }),
      // The prominent switch is the LOCAL one - "does this run on my machine" is what an operator
      // means nine times out of ten. The company-wide pause lives in the ⋯ menu.
      el("button", {
        class: "mini ghost tgl",
        text: loop.activeHere ? "Pause here" : "Run here",
        title: loop.activeHere ? "Stop running this on this machine" : "Run this loop on this machine",
        onClick: () => setLoopActiveHere(loop, !loop.activeHere),
      }),
      el("button", {
        class: "loopmore",
        "aria-label": "More actions for " + loop.title,
        title: "More",
        text: "⋯",
        // stopPropagation, or the document-level outside-click handler (navmenu.js) closes the menu
        // on this very click - the same reason wireTreeActions() stops its menu triggers.
        onClick: (ev) => {
          ev.stopPropagation();
          openLoopMenu(ev.currentTarget, loop);
        },
      }),
    ),
  );
  return card;
}

/**
 * The run strip: one mark per past run, oldest on the left. The card used to carry a single chip for
 * the last run, which meant three failed mornings and one bad night looked identical. A strip makes
 * the PATTERN the thing you see. Each mark opens that run's transcript.
 * @param {object} loop - a row from /api/loops, carrying `runs` newest-first.
 * @returns {HTMLElement|null} null when the loop has never run.
 */
function loopRunStrip(loop) {
  const runs = (loop.runs || []).slice().reverse(); // oldest → newest reads as a timeline
  if (!runs.length) return null;
  return el(
    "div",
    { class: "loopstrip", role: "list", "aria-label": "Recent runs of " + loop.title },
    runs.map((r) =>
      el("span", {
        class: "lrun " + runMarkClass(r.status),
        role: "listitem",
        tabindex: r.sessionId ? "0" : undefined,
        title: runSentence(r),
        "aria-label": runSentence(r),
        onClick: r.sessionId ? () => openChatTab({ id: r.sessionId, title: loop.title, status: "idle" }) : undefined,
      }),
    ),
  );
}

/**
 * One past run in a sentence — the strip's tooltip and the history row's label.
 * @param {object} r - a run entry.
 * @param {{absolute?:boolean}} [opts] - `absolute` drops "7d ago", for the history rows, which
 *   already carry the exact time beside them; saying both is the same fact twice.
 */
function runSentence(r, opts) {
  const words = { ok: "Ran", failed: "Failed", "needs-approval": "Needed you", missed: "Missed" };
  const parts = [(words[r.status] || "Ran") + (opts && opts.absolute ? "" : " " + ago(r.at))];
  if (r.costUsd) parts.push("about " + usd(r.costUsd));
  if (r.blockedOn) parts.push("wanted to " + r.blockedOn);
  return parts.join(" · ");
}

function runMarkClass(status) {
  return { ok: "ok", failed: "bad", "needs-approval": "warn", missed: "cold" }[status] || "cold";
}

/** Every run this machine still remembers, with what each cost and what a blocked one wanted. */
function openLoopHistory(loop) {
  const runs = loop.runs || [];
  const bd = elt("div", "ovbackdrop");
  const card = el(
    "div",
    { class: "ovcard loophist" },
    el("h3", { class: "ovh", text: loop.title }),
    el("p", { class: "ovp", text: runs.length ? "The last " + runs.length + " runs on this machine." : "This loop has not run on this machine yet." }),
    el(
      "div",
      { class: "lh-list" },
      runs.map((r) =>
        el(
          "div",
          {
            class: "lh-row" + (r.sessionId ? " open" : ""),
            ...(r.sessionId
              ? {
                  role: "button",
                  tabindex: "0",
                  onClick: () => {
                    bd.remove();
                    openChatTab({ id: r.sessionId, title: loop.title, status: "idle" });
                  },
                }
              : {}),
          },
          el("span", { class: "lrun " + runMarkClass(r.status) }),
          el("span", { class: "lh-when", text: runWhen(r.at) }),
          el("span", { class: "lh-what", text: runSentence(r, { absolute: true }) }),
        ),
      ),
    ),
    el("div", { class: "ovrow" }, el("button", { class: "mini ghost", text: "Done", onClick: () => bd.remove() })),
  );
  bd.append(card);
  document.body.appendChild(bd);
  bd.onclick = (e) => {
    if (e.target === bd) bd.remove();
  };
}

/** A run's timestamp as a person writes it down. */
function runWhen(at) {
  const d = new Date(at);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The daily spending limit. A loop firing unattended spends the operator's own agent budget, and
 * this is the one control that bounds it. Per machine, because that is whose budget it is; per DAY,
 * because "$5 a day, resetting at midnight" is a sentence an operator can predict, which a rolling
 * window is not.
 */
function openLoopBudget() {
  const spend = S.loopSpend || { today: { costUsd: 0 }, month: { costUsd: 0 } };
  const bd = elt("div", "ovbackdrop");
  const input = el("input", {
    class: "ovinput lb-cap",
    type: "number",
    min: "0",
    step: "0.5",
    placeholder: "No limit",
    value: spend.capUsd === undefined ? "" : String(spend.capUsd),
  });
  const msg = el("span", { class: "emsg" });
  const save = async () => {
    const raw = input.value.trim();
    const capUsd = raw === "" ? 0 : Number(raw);
    if (Number.isNaN(capUsd) || capUsd < 0) {
      msg.className = "emsg bad";
      msg.textContent = "Enter an amount, or leave it blank for no limit.";
      return;
    }
    msg.className = "emsg";
    msg.textContent = "Saving…";
    try {
      S.loopSpend = await postJSON("/api/loops-budget", { capUsd });
    } catch (e) {
      msg.className = "emsg bad";
      msg.textContent = "Could not save the limit.";
      return;
    }
    bd.remove();
    renderLoopSpend();
  };
  bd.append(
    el(
      "div",
      { class: "ovcard loopbudget" },
      el("h3", { class: "ovh", text: "Daily limit for loops" }),
      el("p", {
        class: "ovp",
        text:
          "Loops run without you, and each run costs agent usage. Above this much in a day, scheduled runs stop " +
          "until midnight. Running a loop yourself is never blocked — you are there.",
      }),
      el("label", { class: "ovlabel" }, "Stop scheduled runs after (US$ per day)", input),
      el("div", { class: "lb-now", text: "Spent today: about " + usd(spend.today.costUsd) + " · this month: " + usd(spend.month.costUsd) }),
      el("div", { class: "ovrow" },
        el("button", { class: "mini ghost", text: "Cancel", onClick: () => bd.remove() }),
        el("button", { class: "mini lb-save", text: "Save", onClick: save }),
        msg),
      el("div", { class: "ns-note", text: "Costs are what your agent reported. On a subscription plan that is the equivalent API price, not a charge." }),
    ),
  );
  document.body.appendChild(bd);
  bd.onclick = (e) => {
    if (e.target === bd) bd.remove();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") bd.remove();
  };
  input.focus();
}

/** Edit + Delete live behind the card's ⋯ - the row stays one line, and the destructive action is
 *  never a stray tap away from "Run now". Anchored with the shared dropAt()/closeMenus() machinery
 *  the tree menus use, so it escapes the panel's overflow container like they do. */
function openLoopMenu(anchor, loop) {
  closeMenus();
  const menu = el(
    "div",
    { class: "dropdown" },
    el("button", { onClick: () => { closeMenus(); openLoopComposer(loop); } }, el("span", { class: "k", text: "✎" }), "Edit loop"),
    el("button", { onClick: () => { closeMenus(); openLoopHistory(loop); } }, el("span", { class: "k", text: "⌛" }), "Run history"),
    el(
      "button",
      { onClick: () => { closeMenus(); toggleLoop(loop); } },
      el("span", { class: "k", text: loop.enabled ? "⏸" : "▶" }),
      loop.enabled ? "Pause for everyone" : "Resume for everyone",
    ),
    el("button", { onClick: () => { closeMenus(); removeLoop(loop); } }, el("span", { class: "k", text: "⌫" }), "Delete loop"),
  );
  dropAt(menu, anchor);
}

/**
 * When (or whether) this loop runs, in one phrase. Two switches govern it and they mean different
 * things, so the card never just says "paused" and leaves the operator guessing which one is off:
 * `enabled` is company-wide (it lives in the shared loops.yaml), `activeHere` is this machine only.
 * @param {object} loop - a row from /api/loops.
 * @returns {string}
 */
function loopWhenText(loop) {
  if (!loop.enabled) return "paused for everyone";
  if (!loop.activeHere) return "not running on this machine";
  return "next " + fmtNext(loop.nextRun);
}

/** The last-run chip. Clicking one that has a session opens that run's transcript. A successful run
 *  carries its price: "Ran 2h" says nothing about what a loop is costing to leave switched on. */
function loopStatusChip(loop) {
  const last = (loop.runs || [])[0];
  const cost = last && last.costUsd ? " · " + usd(last.costUsd) : "";
  const chips = {
    ok: { text: "Ran " + ago(loop.lastRun) + cost, cls: "ok" },
    running: { text: "Running", cls: "live" },
    failed: { text: "Failed", cls: "bad" },
    "needs-approval": { text: "Needed you", cls: "warn" },
    missed: { text: "Missed", cls: "" },
  };
  const chip = chips[loop.status];
  if (!chip) return null;
  const attrs = { class: "pill " + chip.cls, text: chip.text };
  if (loop.sessionId) {
    attrs.title = "Open this run";
    attrs.role = "button";
    attrs.tabindex = "0";
    attrs.onClick = () => openChatTab({ id: loop.sessionId, title: loop.title, status: "idle" });
  }
  return el("span", attrs);
}

/** Badge the Loops tab while any loop is waiting on the operator, so a blocked loop is visible
 *  without opening the panel. */
function renderLoopBadge() {
  const badge = $("#lbadge");
  if (!badge) return;
  const waiting = (S.loops || []).filter((l) => l.status === "needs-approval").length;
  badge.textContent = String(waiting);
  badge.style.display = waiting ? "" : "none";
}

/**
 * Format a next-run timestamp as a short relative label.
 * @param {number} ms - epoch-millis of the next run (0/falsy when unscheduled).
 * @returns {string} "-", "due now", "soon", "in Nh", or "in Nd".
 */
function fmtNext(ms) {
  if (!ms) return "-";
  const d = ms - Date.now();
  if (d <= 0) return "due now";
  const h = Math.round(d / 3600000);
  if (h < 1) return "soon";
  if (h < 24) return "in " + h + "h";
  return "in " + Math.round(h / 24) + "d";
}

/* ---------- actions ---------- */

/** Fire a loop now and open the session it produced — the operator is here, so the gate can ask. */
async function runLoopNow(loop) {
  try {
    const r = await postJSON("/api/loops/" + loop.name + "/run", {});
    if (r && r.sessionId) {
      if (S.activeProject) {
        await postJSON("/api/projects/" + S.activeProject + "/items", {
          item: { type: "chat", sessionId: r.sessionId, title: loop.title },
        });
      }
      openChatTab({ id: r.sessionId, title: loop.title, status: "running" });
      refreshProjects();
    }
  } catch (e) {
    toast("Could not run " + loop.title);
  }
  refreshLoops();
}

/** Adopt or drop this loop on THIS machine. Nothing else in the company is affected. */
async function setLoopActiveHere(loop, active) {
  try {
    await postJSON("/api/loops/" + loop.name + "/here", { active });
  } catch (e) {
    /* the refresh below shows the true state either way */
  }
  refreshLoops();
}

/** Pause or resume the loop for the whole company (edits the shared loops.yaml). */
async function toggleLoop(loop) {
  try {
    await postJSON("/api/loops/" + loop.name + "/toggle", {});
  } catch (e) {
    /* the refresh below shows the true state either way */
  }
  refreshLoops();
}

function removeLoop(loop) {
  confirmAction({
    title: "Delete this loop?",
    body: "“" + loop.title + "” will stop running. Its past runs stay in your history.",
    confirm: "Delete",
    onConfirm: async () => {
      try {
        await postJSON("/api/loops/" + loop.name + "/remove", {});
      } catch (e) {
        /* the refresh below shows the true state either way */
      }
      refreshLoops();
    },
  });
}

/* ---------- the composer ---------- */

/**
 * Flatten whatever we were handed into the fields the form edits. Two shapes arrive here and they
 * do NOT look alike: a SUGGESTION is already flat ({at, days} / {every}), while a LOOP from
 * /api/loops carries a structured `schedule` object. Reading only the flat keys is what silently
 * emptied the schedule when editing a real loop, so normalise once, here.
 * @param {object} seed - a suggestion or an /api/loops record.
 * @returns {{title:string, prompt:string, verb:string, mode:string, every:string, at:string, days:string[]}}
 */
function loopSeedFields(seed) {
  const src = seed || {};
  const out = {
    title: src.title || "",
    prompt: src.prompt || "",
    verb: src.verb || "",
    mode: "at",
    every: src.every || "",
    at: src.at || "09:00",
    days: String(src.days || "").split(",").map((d) => d.trim()).filter(Boolean),
  };
  if (src.schedule && src.schedule.kind === "every") {
    out.mode = "every";
    out.every = src.schedule.raw || "";
  } else if (src.schedule && src.schedule.kind === "at") {
    out.mode = "at";
    out.at = String(src.schedule.hour).padStart(2, "0") + ":" + String(src.schedule.minute).padStart(2, "0");
    out.days = src.schedule.days || [];
  } else if (src.every) {
    out.mode = "every";
  }
  return out;
}

/**
 * Open the inline new/edit-loop form above the list.
 * @param {object} [seed] - a suggestion or an existing loop to pre-fill. An existing loop (one with
 *   a `name`) is EDITED in place; anything else creates.
 */
function openLoopComposer(seed) {
  const host = $("#loopcomposer");
  if (!host) return;
  const src = seed || {};
  const editing = !!src.name;
  const f = loopSeedFields(src);
  const mode = f.mode;

  const title = el("input", { class: "f-title", placeholder: "Monday update", value: f.title });
  const prompt = el("textarea", { class: "f-prompt", rows: "3", placeholder: "Read last week's activity log and draft the Monday update." });
  prompt.value = f.prompt;
  const every = el("input", { class: "f-every", placeholder: "2h", value: f.every });
  const at = el("input", { class: "f-at", type: "time", value: f.at });
  const days = el(
    "div",
    { class: "loopdays" },
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) =>
      el("button", {
        class: "daybtn" + (f.days.includes(d) ? " on" : ""),
        type: "button",
        // Two letters, so the whole week fits one row in a ~250px rail without orphaning Sunday.
        text: d[0].toUpperCase() + d.slice(1, 2),
        dataset: { day: d },
        onClick: (ev) => {
          ev.target.classList.toggle("on");
          preview();
        },
      }),
    ),
  );

  // What it runs: free text, or one of the operator's own verbs. Without this the API's verb
  // support is unreachable from the console - a verb loop could only be made by hand-editing
  // loops.yaml, and EDITING one would drop its body on the floor.
  const verb = el("select", { class: "f-verb" }, el("option", { value: "", text: "loading your verbs…" }));
  const bodyMode = f.verb ? "verb" : "prompt";
  const bodySeg = el(
    "div",
    { class: "loopmode", role: "radiogroup", "aria-label": "What it runs" },
    el("button", { class: "seg" + (bodyMode === "prompt" ? " on" : ""), dataset: { body: "prompt" }, text: "A prompt", onClick: () => setBody("prompt") }),
    el("button", { class: "seg" + (bodyMode === "verb" ? " on" : ""), dataset: { body: "verb" }, text: "One of my verbs", onClick: () => setBody("verb") }),
  );

  const modeSeg = el(
    "div",
    { class: "loopmode", role: "radiogroup", "aria-label": "How often" },
    el("button", { class: "seg" + (mode === "every" ? " on" : ""), dataset: { mode: "every" }, text: "Every…", onClick: () => setMode("every") }),
    el("button", { class: "seg" + (mode === "at" ? " on" : ""), dataset: { mode: "at" }, text: "At a time", onClick: () => setMode("at") }),
  );

  const promptRow = el("label", { class: "looprow" }, "What should it do? ", prompt);
  const verbRow = el("label", { class: "looprow" }, "Which verb? ", verb);
  const everyRow = el("label", { class: "looprow" }, "Run every ", every, el("span", { class: "hint", text: "e.g. 30m, 2h, 1d" }));
  const atRow = el("label", { class: "looprow" }, "Run at ", at, days);
  const sentence = el("div", { class: "loopreview", "aria-live": "polite" });
  const msg = el("span", { class: "emsg" });

  const form = el(
    "div",
    { class: "loopform" },
    el("h5", { text: editing ? "Edit loop" : "New loop" }),
    el("label", { class: "looprow" }, "Name it ", title),
    bodySeg,
    promptRow,
    verbRow,
    modeSeg,
    everyRow,
    atRow,
    sentence,
    el(
      "div",
      { class: "ebar" },
      el("button", { class: "mini save", text: editing ? "Save" : "Create loop", onClick: submit }),
      el("button", { class: "mini ghost", text: "Cancel", onClick: close }),
      msg,
    ),
  );

  host.innerHTML = "";
  host.append(form);
  setBody(bodyMode);
  setMode(mode);
  title.focus();
  loadVerbOptions();

  /** Fill the verb picker from the workspace's own verbs, keeping whatever this loop already runs
   *  selected even if the fetch fails (an offline daemon must not silently rewrite the loop). */
  async function loadVerbOptions() {
    let names = [];
    try {
      names = ((await getJSON("/api/skills")).skills || []).map((sk) => sk.name);
    } catch (e) {
      /* fall through - the current verb is still offered below */
    }
    if (f.verb && names.indexOf(f.verb) < 0) names.unshift(f.verb);
    verb.innerHTML = "";
    if (!names.length) {
      verb.append(el("option", { value: "", text: "(teach a verb first)" }));
      return;
    }
    for (const n of names) verb.append(el("option", { value: n, text: n, selected: n === f.verb || undefined }));
    if (f.verb) verb.value = f.verb;
  }

  function setBody(m) {
    for (const b of $$(".seg", bodySeg)) b.classList.toggle("on", b.dataset.body === m);
    promptRow.style.display = m === "prompt" ? "" : "none";
    verbRow.style.display = m === "verb" ? "" : "none";
  }

  function currentBody() {
    const on = $$(".seg", bodySeg).filter((b) => b.classList.contains("on"))[0];
    return on ? on.dataset.body : "prompt";
  }

  function setMode(m) {
    for (const b of $$(".seg", modeSeg)) b.classList.toggle("on", b.dataset.mode === m);
    everyRow.style.display = m === "every" ? "" : "none";
    atRow.style.display = m === "at" ? "" : "none";
    preview();
  }

  function currentMode() {
    const on = $$(".seg", modeSeg).filter((b) => b.classList.contains("on"))[0];
    return on ? on.dataset.mode : "every";
  }

  function schedule() {
    if (currentMode() === "every") return { every: every.value.trim() };
    const picked = $$(".daybtn", days)
      .filter((b) => b.classList.contains("on"))
      .map((b) => b.dataset.day);
    return { at: at.value, days: picked.join(",") };
  }

  /** Echo the schedule back in words while the operator types, so nothing is a surprise on save. */
  function preview() {
    const s = schedule();
    if (currentMode() === "every") {
      sentence.textContent = s.every ? "Runs every " + s.every : "Choose how often it runs.";
      return;
    }
    sentence.textContent = "Runs " + dayWords(s.days) + " at " + (s.at || "—");
  }

  every.oninput = preview;
  at.oninput = preview;

  function close() {
    host.innerHTML = "";
  }

  async function submit() {
    const runs = currentBody() === "verb" ? { verb: verb.value, prompt: "" } : { prompt: prompt.value.trim(), verb: "" };
    const body = Object.assign({ title: title.value.trim() }, runs, schedule());
    if (!body.title || !(body.prompt || body.verb)) {
      msg.className = "emsg bad";
      msg.textContent = "A loop needs a name and something to do.";
      return;
    }
    msg.className = "emsg";
    msg.textContent = editing ? "Saving…" : "Creating…";
    try {
      const r = editing
        ? await patchJSON("/api/loops/" + src.name, body)
        : await postJSON("/api/loops", body);
      if (r && r.error) {
        msg.className = "emsg bad";
        msg.textContent = r.error;
        return;
      }
      close();
      refreshLoops();
    } catch (e) {
      msg.className = "emsg bad";
      msg.textContent = (e && e.message) || "Could not save this loop.";
    }
  }
}

/** "mon,wed" → "on Monday and Wednesday" — the composer's local echo (the daemon owns the real one). */
function dayWords(csv) {
  const names = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
  const list = String(csv)
    .split(",")
    .map((d) => names[d.trim()])
    .filter(Boolean);
  if (!list.length) return "every day";
  if (list.length === 1) return "every " + list[0];
  return "every " + list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
}
