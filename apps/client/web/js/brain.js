"use strict";
// Brain view — the live company system map + animated loop.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
//
// Builds the "brain" tab: an animated SVG map of the company system — the loop (Sensor ·
// Policy · Tools · Gate · Learning) drawn around ONE BRAIN — with a side rail that drills
// into each stage's live data. Reads everything over the local console API and renders on demand.
// State it reads on the shared global `S`: `S.tabs` (open tabs, to find/focus the brain tab) and
// `S.config` (company name + repo roots, used as fallback labels and to build doc links).
/* ---------- Brain view: the company system, live ----------
   Click the "BuildEx" brand → a center tab showing the loop (Sensor · Policy · Tools ·
   Gate · Learning) around ONE BRAIN. Each node carries a live count; tap it to zoom
   into that component's real data - connectors & their status, the verbs you've decided,
   the agent's live tools, the Pending gate, and the decisions accruing in git. */

/** Open the brain tab (focusing it if already open), then kick off a data load. */
function openBrainTab() {
  const ex = S.tabs.find((t) => t.type === "brain");
  if (ex) {
    activateTab(ex.id);
    loadBrain(ex);
    return;
  }
  const tab = addTab({ type: "brain", title: "Brain" });
  tab.pane.className = "pane brainpane on";
  tab.focusKey = "";
  tab.pane.innerHTML = '<div class="bloading">Reading your brain…</div>';
  loadBrain(tab);
}

/**
 * Fetch every brain data source in parallel, stash a normalized snapshot on the tab, and render.
 * Each source falls back to an empty shape so one failed endpoint never blanks the whole view.
 * @param {object} tab - the brain tab; gains a `tab.brain` snapshot as a side effect.
 */
async function loadBrain(tab) {
  const [conn, gw, pend, skills, changes, cfg] = await Promise.all([
    getJSON("/api/connectors").catch(() => ({ connectors: [] })),
    getJSON("/api/connectors/gateway").catch(() => ({ status: [], tools: [] })),
    getJSON("/api/pending").catch(() => ({ cards: [] })),
    getJSON("/api/skills").catch(() => ({ skills: [] })),
    getJSON("/api/changes").catch(() => ({ changes: [] })),
    getJSON("/api/config").catch(() => ({})),
  ]);
  tab.brain = { conn: conn.connectors || [], gw: gw || { status: [], tools: [] }, pend: pend.cards || [], skills: skills.skills || [], changes: changes.changes || [], cfg: cfg || {} };
  renderBrain(tab);
}

/**
 * Derive the five loop nodes (Sensor · Policy · Tools · Gate · Learning) with live counts + labels.
 * @param {object} d - the `tab.brain` snapshot.
 * @returns {Array<{key:string,label:string,accent:string,count:number,sub:string}>} node descriptors.
 */
function brainNodes(d) {
  const st = d.gw.status || [],
    tools = (d.gw.tools || []).filter((t) => t.kind !== "hidden"); // agent-visible only (hidden are managed in the MCP editor)
  const sensLive = d.conn.filter((c) => c.connected).length + st.filter((s) => s.connected).length;
  return [
    { key: "sensor", label: "Sensor", accent: "brand", count: sensLive, sub: sensLive + " live" },
    { key: "policy", label: "Policy", accent: "brand", count: d.skills.length, sub: d.skills.length + " verb" + (d.skills.length === 1 ? "" : "s") },
    { key: "tools", label: "Tools", accent: "brand", count: tools.length, sub: tools.length + " tool" + (tools.length === 1 ? "" : "s") },
    { key: "gate", label: "Gate", accent: "gate", count: d.pend.length, sub: d.pend.length ? d.pend.length + " pending" : "clear" },
    { key: "learning", label: "Learning", accent: "brand", count: d.changes.length, sub: d.changes.length ? "+" + d.changes.length : "-" },
  ];
}

/**
 * Build the whole loop diagram as an SVG string: outer ring, curved edges, hub-to-node spokes,
 * the pulsing central hub, and one clickable group per node.
 * @param {Array<object>} nodes - node descriptors from brainNodes().
 * @param {string} focusKey - key of the focused node ("" / falsy = overview, nothing focused).
 * @returns {string} the SVG markup.
 */
function buildBrainSvg(nodes, focusKey) {
  const W = 380,
    cx = W / 2,
    cy = W / 2,
    R = 118,
    n = nodes.length,
    pad = 40;
  // Even radial layout: node i sits at -90° + i/n of a full turn, so the first node lands at top.
  const pts = nodes.map((_, i) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R };
  });
  const foc = focusKey ? nodes.findIndex((nd) => nd.key === focusKey) : -1;
  let s = '<svg viewBox="' + (-pad) + ' ' + (-pad) + ' ' + (W + pad * 2) + ' ' + (W + pad * 2) + '" class="bsvg" aria-hidden="true">';
  // Blur-based glow filter reused by the flowing particles.
  s += '<defs><filter id="bgl" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
  s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" stroke="var(--line-2)" stroke-width="1" opacity="' + (foc >= 0 ? .35 : .7) + '"/>';
  // Curved arcs between adjacent nodes (control point pulled to 72% of the radius for the bow).
  for (let j = 0; j < n; j++) {
    const p0 = pts[j],
      p1 = pts[(j + 1) % n],
      mx = (p0.x + p1.x) / 2,
      my = (p0.y + p1.y) / 2,
      qx = cx + (mx - cx) * .72,
      qy = cy + (my - cy) * .72;
    s += '<path class="bedge" d="M' + p0.x + ' ' + p0.y + ' Q' + qx + ' ' + qy + ' ' + p1.x + ' ' + p1.y + '" fill="none" stroke="var(--brand)" stroke-width="1.4" opacity="' + (foc >= 0 ? .14 : .4) + '"/>';
  }
  // Hub-to-node spokes: the focused node's spoke is solid + colored, the rest are dashed + dim.
  for (let i = 0; i < n; i++) {
    const on = foc < 0 || foc === i,
      fc = foc === i;
    s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + pts[i].x + '" y2="' + pts[i].y + '" stroke="' + (fc ? (nodes[i].accent === "gate" ? "var(--gate)" : "var(--brand)") : "var(--line-2)") + '" stroke-width="' + (fc ? 1.6 : 1) + '"' + (fc ? '' : ' stroke-dasharray="2 4"') + ' opacity="' + (on ? .9 : .12) + '"/>';
  }
  // The pulsing central hub (BRAIN / ONE REPO); its empty data-k clears focus back to overview.
  s += '<g class="bnode bhub" data-k="" style="cursor:pointer">';
  s += '<circle cx="' + cx + '" cy="' + cy + '" r="30" fill="var(--brand)" opacity=".12"><animate attributeName="r" values="27;38;27" dur="3.6s" repeatCount="indefinite"/><animate attributeName="opacity" values=".16;0;.16" dur="3.6s" repeatCount="indefinite"/></circle>';
  s += '<circle cx="' + cx + '" cy="' + cy + '" r="26" fill="var(--panel-2)" stroke="var(--brand)" stroke-width="1.5"/>';
  s += '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" fill="var(--brand)" font-family="var(--mono)" font-size="9.5" font-weight="700">BRAIN</text>';
  s += '<text x="' + cx + '" y="' + (cy + 10) + '" text-anchor="middle" fill="var(--faint)" font-family="var(--mono)" font-size="7" letter-spacing=".08em">ONE REPO</text>';
  s += '</g>';
  nodes.forEach((nd, i) => {
    const p = pts[i],
      on = foc < 0 || foc === i,
      fc = foc === i,
      col = nd.accent === "gate" ? "var(--gate)" : "var(--brand)",
      r = fc ? 9 : 6.5;
    s += '<g class="bnode" data-k="' + nd.key + '" style="cursor:pointer" opacity="' + (on ? 1 : .28) + '">';
    s += '<circle cx="' + p.x + '" cy="' + p.y + '" r="17" fill="transparent"/>'; // oversized invisible hit target
    if (fc) s += '<circle cx="' + p.x + '" cy="' + p.y + '" r="13" fill="' + col + '" opacity=".16"/>';
    s += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="var(--bg)" stroke="' + col + '" stroke-width="2"/>';
    // A pending gate gets an extra animated ping ring to draw the eye toward the approvals.
    if (nd.key === "gate" && nd.count > 0) s += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="none" stroke="var(--gate)" stroke-width="1.5" opacity=".8"><animate attributeName="r" values="' + r + ';16;' + r + '" dur="2.2s" repeatCount="indefinite"/><animate attributeName="opacity" values=".8;0;.8" dur="2.2s" repeatCount="indefinite"/></circle>';
    // Label sits just outside the node; the text anchor flips side so it never overlaps the ring.
    const lx = cx + (p.x - cx) * 1.34,
      ly = cy + (p.y - cy) * 1.34,
      anchor = Math.abs(lx - cx) < 24 ? "middle" : (lx > cx ? "start" : "end");
    s += '<text x="' + lx + '" y="' + ly + '" text-anchor="' + anchor + '" fill="' + (nd.accent === "gate" ? "var(--gate)" : "var(--ink)") + '" font-family="var(--sans)" font-size="12.5" font-weight="600">' + esc(nd.label) + '</text>';
    s += '<text x="' + lx + '" y="' + (ly + 13) + '" text-anchor="' + anchor + '" fill="var(--faint)" font-family="var(--mono)" font-size="9.5">' + esc(nd.sub) + '</text>';
    s += '</g>';
  });
  return s + '</svg>';
}

/** Render the brain stage (SVG) + side rail, wire node clicks to focus, and start the flow anim. */
function renderBrain(tab) {
  const d = tab.brain;
  if (!d) return;
  const nodes = brainNodes(d),
    foc = tab.focusKey || "";
  tab.pane.innerHTML = '<div class="brainwrap"><div class="brainstage">' + buildBrainSvg(nodes, foc) + '<div class="bstagecap">your company brain - live</div></div><div class="brainrail" id="brail"></div></div>';
  // Clicking a node (or the hub, whose data-k is "") sets focus and re-renders.
  $$(".bnode", tab.pane).forEach((g) => g.onclick = () => {
    tab.focusKey = g.dataset.k || "";
    renderBrain(tab);
  });
  renderBrainRail(tab, $("#brail", tab.pane), nodes);
  startBrainFlow(tab);
}

// teal particles riding the loop - the company brain, alive. Carries the website hero's
// treatment (site.js buildLoop) into the console. Generation-guarded so re-render-on-tap and
// tab-close both stop the prior loop cleanly; fully disabled under prefers-reduced-motion.
/**
 * Animate glowing particles flowing along the loop edges of the current brain SVG.
 * @param {object} tab - the brain tab; its `_flowGen`/`_flowStop` guard the animation lifecycle.
 */
function startBrainFlow(tab) {
  // Bump the generation token; any in-flight frame from an older render sees the mismatch and stops.
  const gen = (tab._flowGen = (tab._flowGen || 0) + 1);
  if (tab._flowStop) {
    tab._flowStop();
    tab._flowStop = null;
  }
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const svg = $(".bsvg", tab.pane);
  if (!svg) return;
  const edges = $$(".bedge", svg);
  if (!edges.length) return;
  const lens = edges.map((e) => e.getTotalLength());
  const maxOp = tab.focusKey ? .26 : .95, // dim the flow when a node is focused
    perSeg = 2,
    ns = "http://www.w3.org/2000/svg",
    dots = [];
  // Seed `perSeg` particles per edge, staggered along it (+ a little jitter) so the flow reads even.
  for (let e = 0; e < edges.length; e++)
    for (let k = 0; k < perSeg; k++) {
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("r", "2.3");
      c.setAttribute("fill", "var(--brand)");
      c.setAttribute("filter", "url(#bgl)");
      c.setAttribute("opacity", "0");
      svg.appendChild(c);
      dots.push({ el: c, seg: e, t: (k / perSeg) + Math.random() * .1 });
    }
  let raf = 0,
    last = null,
    stopped = false;
  function stop() {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    dots.forEach((d) => d.el.remove());
  }
  tab._flowStop = stop;
  function frame(now) {
    // Stop if superseded by a newer render, told to stop, or the SVG left the DOM (tab closed).
    if (stopped || tab._flowGen !== gen || !document.contains(svg)) {
      stop();
      return;
    }
    if (last == null) last = now;
    const dt = Math.min(48, now - last); // clamp big gaps (e.g. tab backgrounded) so dots don't jump
    last = now;
    for (const o of dots) {
      o.t += (dt / 1000) * .3;
      if (o.t >= 1) {
        // reached the end of its edge — wrap to the start of the next edge
        o.t -= 1;
        o.seg = (o.seg + 1) % edges.length;
      }
      const p = edges[o.seg].getPointAtLength(o.t * lens[o.seg]);
      o.el.setAttribute("cx", p.x);
      o.el.setAttribute("cy", p.y);
      // fade in/out over the edge with a sine so particles brighten mid-span, dim at the joints
      o.el.setAttribute("opacity", (maxOp * (.3 + .7 * Math.sin(o.t * Math.PI))).toFixed(2));
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
}

/**
 * Format a past timestamp as a compact relative age ("just now" / "5m ago" / "3h ago" / "2d ago").
 * @param {number} ms - epoch milliseconds in the past.
 * @returns {string} the relative age.
 */
function btime(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const dd = Math.floor(h / 24);
  return dd + "d ago";
}

/**
 * Render the side rail: an overview grid when nothing is focused, or a stage-specific detail
 * panel (sensor / policy / tools / gate / learning) with a Back button when a node is focused.
 * @param {object} tab - the brain tab (carries `tab.brain` + `tab.focusKey`).
 * @param {HTMLElement} host - the rail container to fill.
 * @param {Array<object>} nodes - node descriptors from brainNodes().
 */
function renderBrainRail(tab, host, nodes) {
  const d = tab.brain,
    foc = tab.focusKey || "",
    teamRoot = (S.config.roots || []).map((r) => r.name).find((n) => n !== "core") || "team"; // first non-core repo root, for doc links
  if (!foc) {
    // ----- Overview: company header, a count cell per stage, legend, refresh -----
    const cname = (d.cfg.company && d.cfg.company.name) || (S.config.company && S.config.company.name) || "Your company";
    let html = '<div class="beyebrow">Overview</div><h3 class="bh">' + esc(cname) + "’s brain</h3>" +
      '<p class="bp">Your whole company as one versioned repo. The agent runs the loop around it - you hold the gate. Tap any stage to look inside.</p><div class="bgrid">';
    // Each cell shows the count plus the non-numeric remainder of the sub-label (e.g. "verbs").
    nodes.forEach((nd) => {
      html += '<button class="bcell' + (nd.accent === "gate" ? " gate" : "") + '" data-k="' + nd.key + '"><div class="bk">' + esc(nd.label) + '</div><div class="bv">' + nd.count + '<span class="bvs">' + esc(nd.sub.replace(String(nd.count), "").trim() || "") + '</span></div></button>';
    });
    html += '</div><div class="blegend"><div class="bleg"><span class="blegd brand"></span>the agent - reads, drafts, files</div><div class="bleg"><span class="blegd gate"></span>your tap - the gate to the outside</div></div>' +
      '<button class="brefresh">↻ Refresh</button>';
    host.innerHTML = html;
    $$(".bcell", host).forEach((b) => b.onclick = () => {
      tab.focusKey = b.dataset.k;
      renderBrain(tab);
    });
    $(".brefresh", host).onclick = () => loadBrain(tab);
    return;
  }
  const gate = foc === "gate";
  let html = '<button class="bback">← Overview</button><div class="beyebrow' + (gate ? " gate" : "") + '">' + esc(foc) + '</div>';
  if (foc === "sensor") {
    // Legacy connector/MCP-source cards hidden here (Task 7 - the Store is now the one path in);
    // backend + openConnectorEditor/openMcpEditor are left intact, just unreached from this view.
    html += '<h3 class="bh">What comes in</h3><p class="bp">External sources come in as read-only files, brought in by packs installed from the App Store. The agent reads them; nothing is ever sent from here.</p><div class="bstat">read-only by construction · outward actions always go through the gate</div>';
    host.innerHTML = html;
    $(".bback", host).onclick = () => {
      tab.focusKey = "";
      renderBrain(tab);
    };
    return;
  }
  if (foc === "policy") {
    // ----- Policy: the operator's verbs (skills); each card opens that skill's tab -----
    html += '<h3 class="bh">What you decided</h3><p class="bp">Your verbs - how this company handles a kind of thing, written once. The agent follows them by reading them.</p><div class="bmap" id="bm"></div><div class="bstat">plain markdown · versioned in git · one source of truth</div>';
    host.innerHTML = html;
    const bm = $("#bm", host);
    if (!d.skills.length) bm.innerHTML = '<div class="bempty">No verbs yet - teach your agent one repeatable task.</div>';
    d.skills.forEach((s) => {
      const card = elt("div", "bcard");
      card.innerHTML = '<div class="bct"><span class="bcn">✦ ' + esc(s.name) + '</span></div><div class="bcd">' + esc(s.description || "") + '</div>';
      card.onclick = () => openSkillTab(s.name);
      bm.appendChild(card);
    });
    $(".bback", host).onclick = () => {
      tab.focusKey = "";
      renderBrain(tab);
    };
    return;
  }
  if (foc === "tools") {
    // ----- Tools: the agent-visible MCP tools + the bright-line explainer -----
    const tools = (d.gw.tools || []).filter((t) => t.kind !== "hidden"); // agent-visible only; hidden are managed in the MCP editor
    html += '<h3 class="bh">The agent works</h3><p class="bp">Your own agent operates on the brain’s files directly, plus any live MCP tools. Read tools pass through; write/send tools wait for your tap.</p><div class="bmap" id="bm"></div>' +
      '<div class="bbright">▲ Bright line - the agent drafts, edits and files freely, but the moment an action reaches outward it stops and waits for you.</div><div class="bstat">your subscription · your machine · data never leaves</div>';
    host.innerHTML = html;
    const bm = $("#bm", host);
    if (!tools.length) bm.innerHTML = '<div class="bempty">No live tools yet. Add an MCP server to give the agent gated, live tools.</div>';
    tools.forEach((t) => {
      // Tool names are "connector__verb"; split off the connector prefix for a compact label.
      const conn = t.name.split("__")[0],
        short = t.name.indexOf("__") >= 0 ? t.name.slice(t.name.indexOf("__") + 2) : t.name;
      const row = elt("div", "btool");
      row.innerHTML = '<span class="pill ' + (t.kind === "gated" ? "warn" : "ok") + '">' + esc(t.kind) + '</span> <code>' + esc(short) + '</code><span class="btd">' + esc(conn) + '</span>';
      bm.appendChild(row);
    }); // read-only status row - no live click path to the MCP editor (Task 7)
    $(".bback", host).onclick = () => {
      tab.focusKey = "";
      renderBrain(tab);
    };
    return;
  }
  if (foc === "gate") {
    // ----- Gate: pending approval cards; each Approve/Deny resolves then reloads the brain -----
    html += '<h3 class="bh">You approve</h3><p class="bp">Anything outward or irreversible waits here for a human tap. Autonomy is something the gate grants, loop by loop.</p><div class="bmap" id="bm"></div><div class="bstat gate">the one place a human taps · the scarce unit is approval-hours</div>';
    host.innerHTML = html;
    const bm = $("#bm", host);
    if (!d.pend.length) bm.innerHTML = '<div class="bempty">✓ All caught up - nothing waiting.</div>';
    d.pend.forEach((c) => {
      const name = (c.tool && c.tool.name) || "action",
        input = c.tool && c.tool.input ? JSON.stringify(c.tool.input) : "";
      const card = elt("div", "bpend");
      card.innerHTML = '<div class="bpt">' + esc(name) + '</div>' + (input ? '<div class="bpd">' + esc(input) + '</div>' : '') + '<div class="bpa"><button class="approve">Approve</button><button class="dny">Deny</button></div>';
      $(".approve", card).onclick = async () => {
        await resolveCard(c.id, "approve");
        loadBrain(tab);
      };
      $(".dny", card).onclick = async () => {
        await resolveCard(c.id, "deny");
        loadBrain(tab);
      };
      bm.appendChild(card);
    });
    $(".bback", host).onclick = () => {
      tab.focusKey = "";
      renderBrain(tab);
    };
    return;
  }
  // learning
  // ----- Learning: recent commits; each file chip opens that doc under the team repo root -----
  html += '<h3 class="bh">It accrues</h3><p class="bp">Every approved outcome commits back to the brain. It compounds over time - and because it’s git, every step is reversible.</p><div class="bmap" id="bm"></div><div class="bstat">git history · reversible · the brain compounds</div>';
  host.innerHTML = html;
  const bm = $("#bm", host);
  if (!d.changes.length) bm.innerHTML = '<div class="bempty">No commits yet. As decisions land, they show up here.</div>';
  d.changes.forEach((ch) => {
    const card = elt("div", "bdiff");
    let chips = "";
    (ch.files || []).slice(0, 4).forEach((f) => {
      chips += '<span class="bchip" data-f="' + escAttr(f) + '">' + esc(f) + '</span>';
    });
    card.innerHTML = '<div class="bds">' + esc(ch.subject) + '</div><div class="bdm">' + esc(ch.author || "") + ' · ' + btime(ch.at) + ' · ' + esc(String(ch.sha).slice(0, 7)) + '</div>' + (chips ? '<div class="bdf">' + chips + '</div>' : '');
    $$(".bchip", card).forEach((ch2) => ch2.onclick = () => openDocTab(teamRoot + "/" + ch2.dataset.f));
    bm.appendChild(card);
  });
  $(".bback", host).onclick = () => {
    tab.focusKey = "";
    renderBrain(tab);
  };
}
