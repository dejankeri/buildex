// buildexponential.org - shared behavior. Zero dependencies. Everything degrades:
// content is visible without JS; motion is fully disabled under prefers-reduced-motion.
(function () {
  "use strict";
  document.documentElement.classList.add("js");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── theme toggle (persisted) ─────────────────────────────────────────── */
  try {
    var saved = localStorage.getItem("BuildEx-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch (e) {}
  document.addEventListener("click", function (ev) {
    var t = ev.target.closest && ev.target.closest("[data-theme-toggle]");
    if (!t) return;
    var cur = document.documentElement.getAttribute("data-theme");
    var dark = cur ? cur === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    var next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("BuildEx-theme", next); } catch (e) {}
  });

  /* ── sticky header shadow after scroll ────────────────────────────────── */
  var hdr = document.querySelector(".hdr");
  if (hdr) {
    var onScroll = function () { hdr.classList.toggle("scrolled", window.scrollY > 8); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ── scroll reveal + on-screen animation gating ───────────────────────── */
  var animated = document.querySelectorAll(".rv, .mk-appr, .mk-map, .mk-diff, .ask");
  if (reduce || !("IntersectionObserver" in window)) {
    animated.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
    animated.forEach(function (el) { io.observe(el); });
  }

  /* ── the signature hero: the company loop, alive ──────────────────────── */
  // Sensor → Rules & Skills → Tools → Gate → Learning orbiting ONE BRAIN. Teal particles ride
  // the loop; the Gate node pulses amber - the one place a human taps. Built with raw SVG.
  var host = document.getElementById("loop");
  if (host) buildLoop(host);

  /* ── "just ask. you approve." micro-demos ─────────────────────────────── */
  // Each .ask-stage[data-anim] gets a tiny abstract SVG: teal = the agent
  // working, amber = the human gate. CSS keyframes drive it; the .ask.in class
  // (added on scroll) unpauses the animation. Raw SVG, no deps.
  buildAsks();

  /* ── download button: only personalize the label for macOS visitors ────── */
  // macOS (Apple Silicon) ships first. Only Mac visitors get the OS-specific
  // "Download for Mac" label (the HTML default). Every other visitor - Windows,
  // Linux, mobile, or unknown - gets a neutral "Download" that leads to the
  // download page, which is honest about what's shipping. We never label a
  // button for a build that doesn't exist yet.
  (function () {
    var os = detectOS();
    if (os === "Mac") return; // HTML default already reads "Download for Mac"
    var ctas = document.querySelectorAll("[data-dl-cta]");
    for (var i = 0; i < ctas.length; i++) {
      ctas[i].innerHTML = 'Download <span class="ar">→</span>';
    }
  })();

  function detectOS() {
    var uad = navigator.userAgentData && navigator.userAgentData.platform;
    var plat = (uad || navigator.platform || "").toLowerCase();
    var ua = (navigator.userAgent || "").toLowerCase();
    if (/win/.test(plat) || /windows/.test(ua)) return "Windows";
    if (/mac/.test(plat) || (/mac os x/.test(ua) && !/iphone|ipad/.test(ua))) return "Mac";
    if ((/linux|x11/.test(plat) || /linux/.test(ua)) && !/android/.test(ua)) return "Linux";
    return null; // unknown (incl. mobile) → keep the default label
  }

  /* ── theory-page visuals (only present on the Exponential Organization page) ── */
  var vizzes = document.querySelectorAll("[data-viz]");
  for (var v = 0; v < vizzes.length; v++) {
    var kind = vizzes[v].getAttribute("data-viz");
    if (kind === "loop") buildLoop(vizzes[v], ["ONE", "BRAIN"]);
    else if (kind === "curve") buildCurve(vizzes[v]);
  }

  function buildCurve(host) {
    // headcount stays flat; output curves away - the exponential-org signature
    var svg = svgEl("svg", { viewBox: "0 0 520 300", preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true" });
    // baseline axes
    svg.appendChild(svgEl("line", { x1: 42, y1: 262, x2: 500, y2: 262, stroke: cvar("--line-2"), "stroke-width": "1" }));
    svg.appendChild(svgEl("line", { x1: 42, y1: 30, x2: 42, y2: 262, stroke: cvar("--line-2"), "stroke-width": "1" }));
    // headcount: a nearly flat, gently rising line (dashed, muted)
    svg.appendChild(svgEl("path", { d: "M42 250 L500 214", fill: "none", stroke: cvar("--muted"), "stroke-width": "2", "stroke-dasharray": "4 5", opacity: ".7" }));
    // output: exponential rise, with a soft area fill
    var d = "M42 252 C 190 248, 300 224, 372 168 S 466 66, 500 40";
    var area = svgEl("path", { d: d + " L500 262 L42 262 Z", fill: cvar("--brand"), opacity: ".08" });
    svg.appendChild(area);
    var line = svgEl("path", { d: d, fill: "none", stroke: cvar("--brand"), "stroke-width": "3", "stroke-linecap": "round" });
    svg.appendChild(line);
    // draw-in animation, gated to the reveal (unpaused when host gets .in)
    if (!reduce) {
      var len = line.getTotalLength();
      line.style.strokeDasharray = len; line.style.strokeDashoffset = len;
      area.style.opacity = "0";
      line.style.transition = "stroke-dashoffset 1.4s cubic-bezier(.3,.7,.3,1)";
      area.style.transition = "opacity 1.2s ease .5s";
      var io2 = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting) { line.style.strokeDashoffset = "0"; area.style.opacity = ".08"; io2.unobserve(e.target); }
        });
      }, { threshold: 0.35 });
      io2.observe(host);
    }
    // endpoint dots + labels
    svg.appendChild(svgEl("circle", { cx: 500, cy: 40, r: 4, fill: cvar("--brand") }));
    svg.appendChild(svgEl("circle", { cx: 500, cy: 214, r: 3.5, fill: cvar("--muted") }));
    var lo = svgEl("text", { x: 494, y: 30, "text-anchor": "end", fill: cvar("--brand"), "font-family": "Geist Mono, monospace", "font-size": "12", "font-weight": "500" });
    lo.textContent = "output"; svg.appendChild(lo);
    var lh = svgEl("text", { x: 494, y: 232, "text-anchor": "end", fill: cvar("--muted"), "font-family": "Geist Mono, monospace", "font-size": "11" });
    lh.textContent = "headcount"; svg.appendChild(lh);
    var yl = svgEl("text", { x: 12, y: 150, "text-anchor": "middle", fill: cvar("--faint"), "font-family": "Geist Mono, monospace", "font-size": "9.5", "letter-spacing": ".1em", transform: "rotate(-90 12 150)" });
    yl.textContent = "VALUE"; svg.appendChild(yl);
    var xl = svgEl("text", { x: 271, y: 284, "text-anchor": "middle", fill: cvar("--faint"), "font-family": "Geist Mono, monospace", "font-size": "9.5", "letter-spacing": ".1em" });
    xl.textContent = "TIME"; svg.appendChild(xl);
    host.appendChild(svg);
  }

  function buildAsks() {
    var NS = "http://www.w3.org/2000/svg";
    function mk(t, a) { var e = document.createElementNS(NS, t); for (var k in a) e.setAttribute(k, a[k]); return e; }
    function rect(s, x, y, w, h, cls, rx, delay) {
      var r = mk("rect", { x: x, y: y, width: w, height: h, rx: rx || 0, "class": cls });
      if (delay != null) r.style.animationDelay = delay + "s";
      s.appendChild(r); return r;
    }
    function stageSvg(host) {
      var s = mk("svg", { viewBox: "0 0 520 104", preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true" });
      host.appendChild(s); return s;
    }

    var stages = document.querySelectorAll(".ask-stage");
    for (var i = 0; i < stages.length; i++) {
      var host = stages[i], s = stageSvg(host), type = host.getAttribute("data-anim");

      if (type === "draft") {
        // context comes in (faint), a draft goes out (teal) as lines type
        rect(s, 40, 16, 210, 34, "a as-bub as-shell", 11, 0);
        rect(s, 58, 30, 160, 6, "a as-type as-faint", 3, 0.15);
        rect(s, 262, 54, 218, 34, "a as-bub as-tealsoft", 11, 0.7);
        rect(s, 280, 63, 182, 6, "a as-type as-teal", 3, 1.0);
        rect(s, 280, 75, 120, 6, "a as-type as-teal", 3, 1.35);

      } else if (type === "scan") {
        // rows of clients scan past; two go quiet and flash amber
        var ys = [16, 30, 44, 58, 72, 86], flags = { 1: 0.9, 4: 2.1 };
        for (var r0 = 0; r0 < ys.length; r0++) {
          var isFlag = flags[r0] !== undefined;
          rect(s, 120, ys[r0], 280, 8, "as-row" + (isFlag ? " a flag" : ""), 4, isFlag ? flags[r0] : null);
          if (isFlag) { var p = mk("circle", { cx: 410, cy: ys[r0] + 4, r: 4, "class": "a as-pip" }); p.style.animationDelay = flags[r0] + "s"; s.appendChild(p); }
        }
        rect(s, 110, 0, 300, 14, "a as-band", 6, 0);

      } else if (type === "write") {
        // a document writes itself, cell by cell (teal)
        var cols = [93, 181, 269, 357], rows = [18, 34, 50, 66];
        for (var c = 0; c < cols.length; c++) for (var rr = 0; rr < rows.length; rr++) {
          rect(s, cols[c], rows[rr], 70, 11, "a as-cell", 3, c * 0.5 + rr * 0.12);
        }

      } else if (type === "capture") {
        // the decision lands in the brain: + lines added, then a check
        rect(s, 60, 20, 190, 7, "as-faint", 3, null);
        rect(s, 60, 42, 250, 8, "a as-add as-teal", 3, 0.35);
        rect(s, 60, 60, 206, 8, "a as-add as-teal", 3, 0.7);
        var ck = mk("path", { d: "M436 34 l10 12 l20 -26", "class": "a as-check" });
        s.appendChild(ck);
      }
    }
  }

  function cvar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function svgEl(name, attrs) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function buildLoop(host, center) {
    center = center || ["BuildEx", "OS"];
    var W = 400, H = 400, cx = W / 2, cy = H / 2, R = 116;
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, "aria-hidden": "true" });

    // defs: link gradient + soft glow filter
    var defs = svgEl("defs", {});
    var grad = svgEl("linearGradient", { id: "lk", gradientUnits: "userSpaceOnUse", x1: 0, y1: 0, x2: W, y2: H });
    grad.appendChild(svgEl("stop", { offset: "0", "stop-color": cvar("--brand"), "stop-opacity": ".05" }));
    grad.appendChild(svgEl("stop", { offset: "1", "stop-color": cvar("--brand"), "stop-opacity": ".45" }));
    defs.appendChild(grad);
    var f = svgEl("filter", { id: "gl", x: "-60%", y: "-60%", width: "220%", height: "220%" });
    f.appendChild(svgEl("feGaussianBlur", { stdDeviation: "3.2", result: "b" }));
    var merge = svgEl("feMerge", {});
    merge.appendChild(svgEl("feMergeNode", { in: "b" }));
    merge.appendChild(svgEl("feMergeNode", { in: "SourceGraphic" }));
    f.appendChild(merge);
    defs.appendChild(f);
    svg.appendChild(defs);

    var stops = [
      { l: "Sensor", s: "it arrives" },
      // "Rules & Skills" is too wide for the 400-unit viewBox on the right-hand node, so it wraps
      // onto a second line (l2) - one stage, two lines, never clipped.
      { l: "Rules", l2: "& Skills", s: "what you decided" },
      { l: "Tools", s: "the agent works" },
      { l: "Gate", s: "you approve", gate: true },
      { l: "Learning", s: "it accrues" }
    ];
    var n = stops.length, pts = [];
    for (var i = 0; i < n; i++) {
      var a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R });
    }

    // orbit ring (faint)
    svg.appendChild(svgEl("circle", { cx: cx, cy: cy, r: R, fill: "none", stroke: cvar("--line"), "stroke-width": "1" }));

    // curved links between consecutive stops (bowed toward center for an orbit feel)
    var paths = [];
    for (var j = 0; j < n; j++) {
      var p0 = pts[j], p1 = pts[(j + 1) % n];
      var mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
      var qx = cx + (mx - cx) * 0.72, qy = cy + (my - cy) * 0.72;
      var d = "M" + p0.x + " " + p0.y + " Q" + qx + " " + qy + " " + p1.x + " " + p1.y;
      var path = svgEl("path", { d: d, fill: "none", stroke: "url(#lk)", "stroke-width": "1.5" });
      svg.appendChild(path);
      paths.push(path);
    }

    // spokes from hub to each node (drawn first so the hub sits above them)
    for (var s = 0; s < n; s++) {
      svg.appendChild(svgEl("line", { x1: cx, y1: cy, x2: pts[s].x, y2: pts[s].y, stroke: cvar("--line"), "stroke-width": "1", "stroke-dasharray": "2 4" }));
    }

    // central brain hub - rendered after the spokes so it paints on top
    var halo = svgEl("circle", { cx: cx, cy: cy, r: 30, fill: cvar("--brand"), opacity: ".14" });
    if (!reduce) { var an = svgEl("animate", { attributeName: "r", values: "26;40;26", dur: "3.6s", repeatCount: "indefinite" });
      var an2 = svgEl("animate", { attributeName: "opacity", values: ".18;0;.18", dur: "3.6s", repeatCount: "indefinite" });
      halo.appendChild(an); halo.appendChild(an2); }
    svg.appendChild(halo);
    svg.appendChild(svgEl("circle", { cx: cx, cy: cy, r: 26, fill: cvar("--bg-2"), stroke: cvar("--brand"), "stroke-width": "1.5", filter: "url(#gl)" }));
    var bt = svgEl("text", { x: cx, y: center[1] ? cy - 2 : cy + 4, "text-anchor": "middle", fill: cvar("--brand"), "font-family": "Geist Mono, monospace", "font-size": "10", "font-weight": "600" });
    bt.textContent = center[0]; svg.appendChild(bt);
    if (center[1]) {
      var bt2 = svgEl("text", { x: cx, y: cy + 11, "text-anchor": "middle", fill: cvar("--faint"), "font-family": "Geist Mono, monospace", "font-size": "7.5", "letter-spacing": ".08em" });
      bt2.textContent = center[1]; svg.appendChild(bt2);
    }

    // nodes
    for (var k = 0; k < n; k++) {
      var pt = pts[k], gate = stops[k].gate, col = gate ? cvar("--gate") : cvar("--brand");
      var node = svgEl("circle", { cx: pt.x, cy: pt.y, r: 6, fill: cvar("--bg"), stroke: col, "stroke-width": "2", filter: "url(#gl)" });
      svg.appendChild(node);
      if (gate && !reduce) {
        var pulse = svgEl("circle", { cx: pt.x, cy: pt.y, r: 6, fill: "none", stroke: col, "stroke-width": "1.5", opacity: ".8" });
        pulse.appendChild(svgEl("animate", { attributeName: "r", values: "6;16;6", dur: "2.2s", repeatCount: "indefinite" }));
        pulse.appendChild(svgEl("animate", { attributeName: "opacity", values: ".8;0;.8", dur: "2.2s", repeatCount: "indefinite" }));
        svg.appendChild(pulse);
      }
      // label placed just outward from the node; anchor by side so text never clips the box
      var lx = cx + (pt.x - cx) * 1.28, ly = cy + (pt.y - cy) * 1.28 + 4;
      var anchor = Math.abs(lx - cx) < 26 ? "middle" : (lx > cx ? "start" : "end");
      var lbl = svgEl("text", { x: lx, y: ly, "text-anchor": anchor, fill: gate ? cvar("--gate") : cvar("--ink"), "font-family": "Geist, sans-serif", "font-size": "12.5", "font-weight": "500" });
      lbl.textContent = stops[k].l; svg.appendChild(lbl);
      if (stops[k].l2) {
        var lbl2 = svgEl("text", { x: lx, y: ly + 14, "text-anchor": anchor, fill: cvar("--ink"), "font-family": "Geist, sans-serif", "font-size": "12.5", "font-weight": "500" });
        lbl2.textContent = stops[k].l2; svg.appendChild(lbl2);
      }
    }

    host.appendChild(svg);

    // particles riding the loop
    if (reduce) return;
    var dots = [];
    for (var d2 = 0; d2 < n; d2++) {
      var dot = svgEl("circle", { r: 2.4, fill: cvar("--brand"), filter: "url(#gl)" });
      svg.appendChild(dot);
      dots.push({ el: dot, seg: d2, t: Math.random() });
    }
    var last = null;
    function frame(now) {
      if (last == null) last = now;
      var dt = Math.min(48, now - last); last = now;
      for (var m = 0; m < dots.length; m++) {
        var o = dots[m], path = paths[o.seg], len = path.getTotalLength();
        o.t += (dt / 1000) * 0.32;
        if (o.t >= 1) { o.t -= 1; o.seg = (o.seg + 1) % n; path = paths[o.seg]; len = path.getTotalLength(); }
        var p = path.getPointAtLength(o.t * len);
        o.el.setAttribute("cx", p.x); o.el.setAttribute("cy", p.y);
        o.el.setAttribute("opacity", (0.35 + 0.65 * Math.sin(o.t * Math.PI)).toFixed(2));
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ── apply form ───────────────────────────────────────────────────────── */
  var form = document.getElementById("applyForm");
  if (form) {
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var status = document.getElementById("formStatus");
      var btn = form.querySelector("button[type=submit]");
      var fd = new FormData(form);
      // Compose the qualification answers into a single readable notes block so the
      // existing /apply edge handler (name/company/email/notes/website) files it verbatim.
      var extras = [
        ["Company size", fd.get("size")],
        ["Which loop hurts most", fd.get("loop")],
        ["Current AI / stack", fd.get("stack")],
        ["Timeline", fd.get("timeline")]
      ].filter(function (r) { return r[1]; }).map(function (r) { return r[0] + ": " + r[1]; });
      var msg = (fd.get("notes") || "").toString().trim();
      var notes = (msg ? msg + "\n\n" : "") + extras.join("\n");
      var payload = {
        name: fd.get("name"), company: fd.get("company"), email: fd.get("email"),
        notes: notes, website: fd.get("website") // honeypot
      };
      status.textContent = "Sending…"; status.className = "form-status";
      if (btn) btn.disabled = true;
      fetch("/api/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
        .then(function (res) {
          if (res.ok && res.b && res.b.ok) {
            form.reset();
            status.textContent = "Got it - we'll be in touch. Your application is now a file in our own workspace.";
            status.className = "form-status ok";
          } else {
            status.textContent = (res.b && res.b.error) || "Something went wrong. Email us instead: hello@buildexponential.org";
            status.className = "form-status err";
          }
        })
        .catch(function () {
          status.textContent = "Network error. Email us instead: hello@buildexponential.org";
          status.className = "form-status err";
        })
        .finally(function () { if (btn) btn.disabled = false; });
    });
  }
})();
