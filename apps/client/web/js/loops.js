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
    el("div", { id: "loopcomposer" }),
    el("div", { id: "looplist" }),
  );
  await refreshLoops();
}

/** Fetch loops into `S.loops` and repaint the list (and the tab badge). */
async function refreshLoops() {
  try {
    S.loops = (await getJSON("/api/loops")).loops || [];
  } catch (e) {
    S.loops = [];
  }
  renderLoopBadge();
  if (S.rightTab === "loops") renderLoopList();
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
    { class: "rcard loopcard" + (loop.enabled ? "" : " off"), dataset: { loop: loop.name } },
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
      el("span", { class: "loopnext", text: loop.enabled ? "next " + fmtNext(loop.nextRun) : "paused" }),
    ),
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
      el("button", {
        class: "mini ghost tgl",
        text: loop.enabled ? "Pause" : "Resume",
        onClick: () => toggleLoop(loop),
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

/** Edit + Delete live behind the card's ⋯ - the row stays one line, and the destructive action is
 *  never a stray tap away from "Run now". Anchored with the shared dropAt()/closeMenus() machinery
 *  the tree menus use, so it escapes the panel's overflow container like they do. */
function openLoopMenu(anchor, loop) {
  closeMenus();
  const menu = el(
    "div",
    { class: "dropdown" },
    el("button", { onClick: () => { closeMenus(); openLoopComposer(loop); } }, el("span", { class: "k", text: "✎" }), "Edit loop"),
    el("button", { onClick: () => { closeMenus(); removeLoop(loop); } }, el("span", { class: "k", text: "⌫" }), "Delete loop"),
  );
  dropAt(menu, anchor);
}

/** The last-run chip. Clicking one that has a session opens that run's transcript. */
function loopStatusChip(loop) {
  const chips = {
    ok: { text: "Ran " + ago(loop.lastRun), cls: "ok" },
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
