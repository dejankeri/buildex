"use strict";
// Brain rail — the live company brain as the RIGHT-PANEL navigator.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
//
// This is the "map" half of the brain (the "poster" half is the full animated tab in brain.js). It
// owns the right panel: a compact LIVE star on top (reusing brain.js's brainNodes/buildBrainSvg/
// startBrainFlow), a Company/Private scope lens, and the five loop stages as accordion sections whose
// items open in the CENTER. It replaces the old Pending/Skills/Sync right panels — those stages now
// live in the Gate/Policy/Learning sections here. State it reads/writes on the shared global `S`:
// `S.brain` (the snapshot, shared shape with loadBrain), `S.brainScope` ("all"|"team"|"private"),
// `S.brainOpen` (which sections are expanded), and `S._brail` (the flow-animation holder).

/* ---------- the brain snapshot (same six sources loadBrain() reads) ---------- */

/** Fetch every brain source in parallel into `S.brain`, then paint — unless the operator switched
 *  away mid-fetch. Each source falls back to an empty shape so one dead endpoint never blanks the map. */
async function rBrain() {
  const p = $("#rpanel");
  if (!S.brain) p.innerHTML = '<div class="bloading">Reading your brain…</div>';
  const [conn, gw, pend, skills, changes, cfg] = await Promise.all([
    getJSON("/api/connectors").catch(() => ({ connectors: [] })),
    getJSON("/api/connectors/gateway").catch(() => ({ status: [], tools: [] })),
    getJSON("/api/pending").catch(() => ({ cards: [] })),
    getJSON("/api/skills").catch(() => ({ skills: [] })),
    getJSON("/api/changes").catch(() => ({ changes: [] })),
    getJSON("/api/config").catch(() => ({})),
  ]);
  S.brain = { conn: conn.connectors || [], gw: gw || { status: [], tools: [] }, pend: pend.cards || [], skills: skills.skills || [], changes: changes.changes || [], cfg: cfg || {} };
  if (S.rightTab !== "brain") return; // switched away while the fetch was in flight
  renderBrainPanel();
}

/** The current scope lens: "all" | "team" (Company) | "private" (mine). */
function brainScope() {
  return S.brainScope || "all";
}

/** Persist + apply a new scope, then repaint. */
function setBrainScope(scope) {
  S.brainScope = scope;
  try { localStorage.setItem("buildex.brainScope", scope); } catch (e) {}
  renderBrainPanel();
}

// Which loop stages are OWNER-scoped (team vs mine) vs company-wide. Only verbs (Policy) carry a
// per-item owner — a private skill is genuinely yours; sensors, tools, the gate and the learning
// history are the company's shared brain. So the scope lens filters Policy honestly and leaves the
// company-wide stages labelled as such, never pretending a "Private" view hides them.
const BRAIN_COMPANY_STAGES = { sensor: 1, tools: 1, gate: 1, learning: 1 };

/** The verbs visible under the current scope: all of them, or just one brain's. */
function scopeVerbs(skills) {
  const s = brainScope();
  if (s === "all") return skills;
  return (skills || []).filter((v) => rootSlot(String(v.root || "")) === s);
}

/* ---------- render ---------- */

/** Paint the whole right-panel brain map: the compact live star, the scope lens, and the five
 *  accordion stages. Pure over `S.brain` — the tests drive it directly with a preset snapshot. */
function renderBrainPanel() {
  const p = $("#rpanel");
  if (!p) return;
  const d = S.brain || { conn: [], gw: { status: [], tools: [] }, pend: [], skills: [], changes: [], cfg: {} };
  const nodes = brainNodes(d);
  p.innerHTML = "";

  // The star — a small, LIVE version of the poster. Node dots (and the hub) open the full brain in
  // the centre, focused on that stage; the sections below are the in-rail drill-in.
  const star = elt("div", "brailstar");
  star.innerHTML = buildBrainSvg(nodes, "");
  p.appendChild(star);
  $$(".bnode", star).forEach((g) => g.onclick = () => openBrainTab(g.dataset.k || ""));

  // The scope lens.
  const scope = brainScope();
  const seg = elt("div", "bscope", [["all", "All"], ["team", "Company"], ["private", "Private"]]
    .map(([k, lbl]) => '<button class="bseg' + (k === scope ? " on" : "") + '" data-s="' + k + '">' + lbl + "</button>").join(""));
  p.appendChild(seg);
  $$(".bseg", seg).forEach((b) => b.onclick = () => setBrainScope(b.dataset.s));

  // The five accordion stages.
  const host = elt("div", "bsecs");
  p.appendChild(host);
  nodes.forEach((nd) => renderBrainSection(host, nd, d));

  // Animate the loop (guarded + reduced-motion aware in startBrainFlow; a fresh render's SVG replaces
  // the old one, so the prior frame loop sees its SVG leave the DOM and stops itself).
  S._brail = S._brail || {};
  S._brail.pane = p;
  S._brail.focusKey = "";
  startBrainFlow(S._brail);
}

// One glyph per stage — mirrors the map's language (✦ is the verb/star mark used throughout).
const BRAIN_STAGE_ICON = { sensor: "◈", policy: "✦", tools: "⚙", gate: "⚠", learning: "↺" };
const BRAIN_STAGE_LABEL = { sensor: "Sensors", policy: "Policy · Verbs", tools: "Tools", gate: "Gate", learning: "Learning" };

/** Whether stage `key` is expanded right now. Default: closed, except the Gate opens itself when it
 *  has something waiting — the one stage that should catch the eye. */
function brainSectionOpen(key, d) {
  const remembered = S.brainOpen[key];
  if (remembered !== undefined) return remembered;
  return key === "gate" && (d.pend || []).length > 0;
}

/** Draw one accordion stage: a header (icon · label · count · caret) and, when open, its items. */
function renderBrainSection(host, nd, d) {
  const companyWide = !!BRAIN_COMPANY_STAGES[nd.key];
  const open = brainSectionOpen(nd.key, d);
  const sec = elt("div", "bsec" + (nd.accent === "gate" ? " gate" : "") + (open ? "" : " closed"));
  const count = nd.key === "policy" ? scopeVerbs(d.skills).length : nd.count;
  // Under a Company/Private lens the company-wide stages say so, so "Private" never reads as
  // "these are hidden/empty for you".
  const tag = companyWide && brainScope() !== "all" ? '<span class="bsec-tag">shared</span>' : "";
  const head = elt("div", "bsec-h",
    '<span class="bsec-ic">' + BRAIN_STAGE_ICON[nd.key] + '</span>'
    + '<span class="bsec-t">' + BRAIN_STAGE_LABEL[nd.key] + '</span>' + tag
    + '<span class="bsec-c">' + count + '</span><span class="bcaret">▾</span>');
  head.onclick = () => {
    S.brainOpen[nd.key] = sec.classList.toggle("closed") ? false : true;
  };
  sec.appendChild(head);
  const body = elt("div", "bsec-b");
  sec.appendChild(body);
  renderBrainSectionBody(body, nd.key, d);
  host.appendChild(sec);
}

/** Fill a stage's body with its live items — reusing the same actions the poster's rail wired
 *  (openSkillTab, resolveCard, openDocTab) so a click here and a click there do the same thing. */
function renderBrainSectionBody(body, key, d) {
  if (key === "policy") {
    const verbs = scopeVerbs(d.skills);
    if (!verbs.length) {
      body.appendChild(elt("div", "bempty", brainScope() === "private" ? "No private verbs yet." : "No verbs yet — teach your agent one."));
    } else {
      verbs.forEach((s) => {
        const card = elt("div", "rcard rclick", '<div class="cn">✦ ' + esc(s.name) + '</div><div class="cd">' + esc(s.description || "") + "</div>");
        card.onclick = () => openSkillTab(s.name);
        body.appendChild(card);
      });
    }
    const teach = elt("button", "bsec-add", "+ Teach a verb");
    teach.onclick = () => openSkillEditor(null);
    body.appendChild(teach);
    return;
  }
  if (key === "gate") {
    if (!d.pend.length) { body.appendChild(elt("div", "bempty", "✓ All caught up — nothing waiting.")); return; }
    d.pend.forEach((c) => {
      const name = (c.tool && c.tool.name) || "action",
        input = c.tool && c.tool.input ? JSON.stringify(c.tool.input) : "";
      const card = elt("div", "bpend", '<div class="bpt">' + esc(name) + "</div>" + (input ? '<div class="bpd">' + esc(input) + "</div>" : "") + '<div class="bpa"><button class="approve">Approve</button><button class="dny">Deny</button></div>');
      $(".approve", card).onclick = async () => { await resolveCard(c.id, "approve"); rBrain(); };
      $(".dny", card).onclick = async () => { await resolveCard(c.id, "deny"); rBrain(); };
      body.appendChild(card);
    });
    return;
  }
  if (key === "learning") {
    if (!d.changes.length) { body.appendChild(elt("div", "bempty", "No commits yet. As decisions land, they show up here.")); return; }
    const teamRoot = (S.config.roots || []).map((r) => r.name).find((n) => n !== "core") || "team";
    d.changes.forEach((ch) => {
      let chips = "";
      (ch.files || []).slice(0, 4).forEach((f) => { chips += '<span class="bchip" data-f="' + escAttr(f) + '">' + esc(f) + "</span>"; });
      const card = elt("div", "bdiff", '<div class="bds">' + esc(ch.subject) + '</div><div class="bdm">' + esc(ch.author || "") + " · " + btime(ch.at) + " · " + esc(String(ch.sha).slice(0, 7)) + "</div>" + (chips ? '<div class="bdf">' + chips + "</div>" : ""));
      $$(".bchip", card).forEach((ch2) => ch2.onclick = () => openDocTab(teamRoot + "/" + ch2.dataset.f));
      body.appendChild(card);
    });
    return;
  }
  if (key === "tools") {
    const tools = (d.gw.tools || []).filter((t) => t.kind !== "hidden");
    if (!tools.length) { body.appendChild(elt("div", "bempty", "No live tools yet. Add an MCP server to give the agent gated, live tools.")); return; }
    tools.forEach((t) => {
      const conn = t.name.split("__")[0],
        short = t.name.indexOf("__") >= 0 ? t.name.slice(t.name.indexOf("__") + 2) : t.name;
      body.appendChild(elt("div", "btool", '<span class="pill ' + (t.kind === "gated" ? "warn" : "ok") + '">' + esc(t.kind) + '</span> <code>' + esc(short) + '</code><span class="btd">' + esc(conn) + "</span>"));
    });
    return;
  }
  // sensor — read-only sources that come in.
  const st = (d.gw.status || []),
    live = d.conn.filter((c) => c.connected).length + st.filter((s) => s.connected).length;
  if (!live && !d.conn.length && !st.length) { body.appendChild(elt("div", "bempty", "No sources connected. Install an app to bring one in.")); return; }
  d.conn.forEach((c) => {
    const nm = c.name || "source";
    body.appendChild(elt("div", "btool", '<span class="bdot ' + (c.connected ? "live" : "off") + '"></span> <code>' + esc(nm) + "</code>"));
  });
  st.forEach((s) => {
    body.appendChild(elt("div", "btool", '<span class="bdot ' + (s.connected ? "live" : "off") + '"></span> <code>' + esc(s.name || "gateway") + "</code>"));
  });
}
