"use strict";
// Quick guided tour — anchored coach-marks that spotlight each real UI region (left panel, sessions,
// screen types, right panel, App Store, company brain) and explain it in a sentence.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via <script src>,
// sharing one global scope. NOT an ES module. Reads/writes no shared-global `S.*`; its only state is
// the localStorage flag `buildex.tour.v1` (a per-profile local file Electron persists) so it shows
// once on a fresh install and is otherwise replayable from the title-bar "?" button.
//
// The card bodies are trusted, author-written strings (the only markup is <b>); no operator/agent
// content flows in, so setting innerHTML here carries no XSS exposure (same pattern as onboarding.js).

const TOUR_FLAG = "buildex.tour.v1"; // bump the suffix to re-show the tour after materially changing it.

/** The tour steps, resolved against the live DOM. Each: an anchor selector (with an optional fallback),
 *  a title + one-sentence body, a preferred card placement, and an optional `before` that reveals the
 *  panel the anchor lives in. Steps whose anchor is absent are skipped, so the tour adapts to the UI. */
function tourStepDefs() {
  const app = () => document.querySelector(".app");
  const openLeft = () => app() && app().classList.remove("lc");
  const openRight = () => app() && app().classList.remove("rc");
  return [
    {
      sel: ".left",
      place: "right",
      before: openLeft,
      title: "The left panel",
      body: "This is home base — your <b>sessions</b> up top and your installed <b>apps</b> below. Hide or show it any time with the <b>⇤</b> button in the title bar.",
    },
    {
      sel: "#newProject",
      alt: "#newSessionTop",
      place: "right",
      before: openLeft,
      title: "Start a session",
      body: "A <b>session</b> is a workspace that keeps everything you open together. Click <b>＋ New session</b> and name it after whatever you're working on.",
    },
    {
      sel: "#tabAdd",
      place: "bottom",
      title: "Open different screens",
      body: "Inside a session, the <b>＋</b> opens different screens: a <b>chat</b> with your agent, a <b>document</b>, a <b>web browser</b>, or your <b>workspace map</b>.",
    },
    {
      sel: "#rtabs",
      place: "bottom",
      before: openRight,
      title: "The right panel",
      body: "Switch it between <b>Pending</b> approvals, <b>Files</b>, <b>Skills</b>, and <b>Apps &amp; connectors</b>. Toggle the whole panel with <b>⇥</b>.",
    },
    {
      sel: ".astore",
      alt: "#newAppTop",
      place: "right",
      before: openLeft,
      title: "Add apps & connectors",
      body: "Open the <b>⊕ Store</b> to install apps and connect <b>Gmail, Calendar, Drive</b> and more — so your agent can work with your real company data.",
    },
    {
      sel: "#brandBtn",
      place: "bottom",
      title: "Your company brain",
      body: "Click <b>BuildEx</b> any time to see your whole company as one living map — files, people, and history, all on your machine.",
    },
  ];
}

let _tour = null; // active tour: { steps, i, back, hole, card, onKey, onMove }

/** The live anchor for a step, re-queried by selector every time (NOT cached): parts of the console
 *  re-render on a timer — the left rail's app list is rebuilt every ~8s, replacing the `.astore` node —
 *  so a captured element reference goes stale mid-tour. Re-querying keeps the spotlight glued. */
function stepEl(s) {
  return document.querySelector(s.sel) || (s.alt ? document.querySelector(s.alt) : null);
}

/** Keep only the steps whose anchor currently exists, so the tour adapts to what's on screen. */
function collectTourSteps() {
  return tourStepDefs().filter((d) => stepEl(d));
}

/** Start the tour. `force` replays it even if it was already seen (the "?" button); without it the
 *  caller is responsible for the once-only check (see maybeAutoTour). */
function startTour(force) {
  if (_tour) return; // already running
  const steps = collectTourSteps();
  if (!steps.length) return;

  const back = elt("div", "tour-back");
  back.onclick = (e) => e.stopPropagation(); // clicks on the dimmed area do nothing (Esc/Skip exits)
  const hole = elt("div", "tour-hole");
  const card = elt("div", "tour-card");
  document.body.append(back, hole, card);

  const onKey = (e) => {
    if (e.key === "Escape") endTour();
    else if (e.key === "ArrowRight" || e.key === "Enter") tourGo(1);
    else if (e.key === "ArrowLeft") tourGo(-1);
  };
  const onMove = () => positionTour(); // keep the spotlight glued to the anchor on resize/scroll
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", onMove);
  window.addEventListener("scroll", onMove, true);

  _tour = { steps, i: 0, back, hole, card, onKey, onMove };
  if (force) void force; // (parameter documents intent; state is the same either way)
  renderTourStep();
}

/** Advance/rewind by `delta`; past the last step finishes the tour. */
function tourGo(delta) {
  if (!_tour) return;
  const next = _tour.i + delta;
  if (next >= _tour.steps.length) return endTour();
  _tour.i = Math.max(0, next);
  renderTourStep();
}

/** Tear down the tour and remember it was seen (whether finished or skipped — never nag). */
function endTour() {
  if (!_tour) return;
  window.removeEventListener("keydown", _tour.onKey);
  window.removeEventListener("resize", _tour.onMove);
  window.removeEventListener("scroll", _tour.onMove, true);
  _tour.back.remove();
  _tour.hole.remove();
  _tour.card.remove();
  _tour = null;
  try { localStorage.setItem(TOUR_FLAG, "1"); } catch (e) {}
}

/** Paint the current step: reveal its panel, fill the card, then glue the spotlight + card to the anchor. */
function renderTourStep() {
  const t = _tour;
  const s = t.steps[t.i];
  if (s.before) s.before();
  const dots = t.steps.map((_, k) => '<span class="' + (k === t.i ? "on" : "") + '"></span>').join("");
  const isLast = t.i === t.steps.length - 1;
  t.card.innerHTML =
    '<div class="tour-step">Step ' + (t.i + 1) + " of " + t.steps.length + "</div>" +
    '<h3 class="tour-t">' + esc(s.title) + "</h3>" +
    '<p class="tour-body">' + s.body + "</p>" +
    '<div class="tour-actions"><div class="tour-dots">' + dots + "</div>" +
    (t.i > 0 ? '<button class="tour-ghost" data-a="back">Back</button>' : '<button class="tour-ghost" data-a="skip">Skip</button>') +
    '<button class="tour-primary" data-a="next">' + (isLast ? "Done" : "Next") + "</button></div>";
  t.card.querySelectorAll("[data-a]").forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.a;
      if (a === "skip") endTour();
      else if (a === "back") tourGo(-1);
      else tourGo(1);
    };
  });
  // Layout changes from before() (a panel opening) settle next frame; position after that.
  requestAnimationFrame(() => positionTour());
}

/** Place the spotlight hole over the current anchor and the card beside it (flipping to stay on-screen). */
function positionTour() {
  if (!_tour) return;
  const s = _tour.steps[_tour.i];
  const anchor = stepEl(s); // re-query live (the node may have been re-rendered since the last paint)
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const pad = 6;
  const hole = _tour.hole;
  hole.style.left = r.left - pad + "px";
  hole.style.top = r.top - pad + "px";
  hole.style.width = r.width + pad * 2 + "px";
  hole.style.height = r.height + pad * 2 + "px";

  const card = _tour.card;
  const gap = 14;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fits = {
    right: r.right + gap + cw <= vw,
    left: r.left - gap - cw >= 0,
    bottom: r.bottom + gap + ch <= vh,
    top: r.top - gap - ch >= 0,
  };
  const order = [s.place, "bottom", "right", "top", "left"];
  const side = order.find((p) => fits[p]) || "bottom";
  let left, top;
  if (side === "right") { left = r.right + gap; top = r.top; }
  else if (side === "left") { left = r.left - gap - cw; top = r.top; }
  else if (side === "top") { left = r.left; top = r.top - gap - ch; }
  else { left = r.left; top = r.bottom + gap; } // bottom
  // Clamp fully on-screen.
  card.style.left = Math.max(12, Math.min(left, vw - cw - 12)) + "px";
  card.style.top = Math.max(12, Math.min(top, vh - ch - 12)) + "px";
}

/** Auto-start the tour once, on a fresh install — but only after the welcome wizard has closed (so the
 *  two never stack). No-op if already seen or if the wizard modal is still up. */
function maybeAutoTour() {
  let seen = null;
  try { seen = localStorage.getItem(TOUR_FLAG); } catch (e) {}
  if (seen) return;
  if (document.querySelector(".wz-backdrop")) return; // wizard still open — it will start the tour on finish
  startTour(false);
}
