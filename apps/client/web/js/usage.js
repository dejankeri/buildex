"use strict";
// Bottom status strip — live Claude subscription usage read-out.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Polls /api/usage (which proxies the Anthropic usage endpoint) and renders the operator's live
// Claude subscription usage as per-segment bars in the bottom status strip. Holds no `S` state.

/**
 * Format an ISO reset timestamp as a compact countdown ("2d 3h" / "3h 20m" / "5m" / "now").
 * @param {string} iso - ISO-8601 reset time; empty/unparseable yields "".
 * @returns {string} the coarsest two-unit time-until-reset, or "" when unknown.
 */
function fmtReset(iso) {
  const t = Date.parse(iso || "");
  if (!t) return "";
  let d = t - Date.now();
  if (d <= 0) return "now";
  const day = Math.floor(d / 86400000);
  d -= day * 86400000;
  const h = Math.floor(d / 3600000),
    m = Math.floor(d % 3600000 / 60000);
  if (day > 0) return day + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}

/**
 * Fetch usage and repaint the bottom strip: one bar per segment, or an "unavailable" note.
 * @param {boolean} [force] - when true, pass ?refresh=1 to bust the server cache and spin the button.
 * @returns {Promise<void>}
 */
async function refreshUsage(force) {
  const btn = $("#usageRefresh");
  if (force && btn) btn.classList.add("spin");
  let u;
  try {
    u = await getJSON("/api/usage" + (force ? "?refresh=1" : ""));
  } catch (e) {
    if (btn) btn.classList.remove("spin");
    return;
  }
  if (btn) btn.classList.remove("spin");
  const host = $("#usage"),
    sb = $("#statusbar");
  if (!host) return;
  host.innerHTML = "";
  if (!u.ok) {
    // Dim the whole strip and show why usage couldn't be read (e.g. not signed in).
    if (sb) sb.classList.add("dim");
    host.innerHTML = '<span class="uoff">' + esc(u.note || "usage unavailable") + "</span>";
    return;
  }
  if (sb) sb.classList.remove("dim");
  (u.segments || []).forEach((s) => {
    const pct = Math.max(0, Math.min(100, s.pct || 0));
    // Escalate colour by explicit severity or by threshold: ≥90% critical, ≥70% warning.
    const sev = (s.severity === "critical" || pct >= 90) ? "crit" : (s.severity === "warning" || pct >= 70) ? "warn" : "";
    const el = elt("div", "useg " + sev);
    el.innerHTML = '<span class="ubar"><i></i></span><span class="upct">' + pct + '%</span><span class="ulabel">' + esc(s.label) + "</span>";
    $(".ubar i", el).style.width = pct + "%";
    const reset = s.resetsAt ? fmtReset(s.resetsAt) : "";
    el.title = esc(s.label) + " · " + pct + "% used" + (reset ? " · resets in " + reset : "");
    host.appendChild(el);
  });
}
