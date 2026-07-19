"use strict";
// Repo map pane.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Renders /api/map (nodes + edges) as a static radial SVG diagram of the repo's documents.
// Reads/writes no shared `S` state — it draws straight into the tab's pane.

/**
 * Load the repo map and render it into `tab.pane` as an inline SVG, or an empty-state message.
 * @param {object} tab - the map tab; its `.pane` element receives the rendered SVG.
 * @returns {Promise<void>}
 */
async function loadMap(tab) {
  let g;
  try {
    g = await getJSON("/api/map");
  } catch (e) {
    tab.pane.innerHTML = '<div class="empty">Map unavailable.</div>';
    return;
  }
  if (!g.nodes.length) {
    tab.pane.innerHTML = '<div class="empty">No documents yet.</div>';
    return;
  }
  // Lay the nodes out on a ring: angle by index, radius stepped in 4 bands so labels don't collide.
  const W = 900,
    H = 560,
    cx = W / 2,
    cy = H / 2,
    pos = {};
  g.nodes.forEach((n, i) => {
    const a = (i / g.nodes.length) * Math.PI * 2,
      r = 130 + (i % 4) * 60;
    pos[n.id] = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
  // Draw edges first so the node dots/labels paint on top of the connecting lines.
  let svg = '<svg viewBox="0 0 ' + W + " " + H + '">';
  (g.edges || []).forEach((e) => {
    const a = pos[e.from],
      b = pos[e.to];
    if (a && b) svg += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="var(--line-2)"/>';
  });
  g.nodes.forEach((n) => {
    const p = pos[n.id];
    svg += '<circle cx="' + p.x + '" cy="' + p.y + '" r="5" fill="var(--brand)"/><text class="nlabel" x="' + (p.x + 8) + '" y="' + (p.y + 3) + '">' + esc(n.label) + "</text>";
  });
  tab.pane.innerHTML = svg + "</svg>";
}
