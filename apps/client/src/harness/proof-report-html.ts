// The proof track's HTML report bundle - a deterministic, provider-neutral, zero-LLM renderer
// (invariant 9). Given the run's ProofResults and the per-case transcripts (already redacted by
// drive-step before they reached disk), it returns the whole bundle as a { relativePath -> content }
// map that proof.ts writes into the run dir. Multi-page and BuildEx-dark-themed: overview (index),
// test plan + matrix, findings, and one drill-down page per scenario with the full transcript.
//
// Everything is HTML-escaped; the renderer never adds a secret the transcript didn't already carry,
// and since it consumes the redacted transcript, the bundle inherits the same secret hygiene as
// report.md's source.
import type { ProofResults } from "./proof-report.js";
import type { UiEvent } from "../agent/types.js";

type Stamped = UiEvent & { at?: string };
type Case = ProofResults["cases"][number];

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const BUCKETS = ["crashes", "functional", "non-functional", "product-ux"] as const;
const bandCls: Record<string, string> = { strong: "b-strong", pass: "b-pass", fail: "b-fail" };
const kindBadge = (k: string) => `<span class="badge ${k === "edge" ? "b-edge" : "b-happy"}">${esc(k)}</span>`;
const first = (s: unknown, n = 160): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};
/** Pretty-print an object, and pretty-print JSON that arrived as a string, so tool output reads. */
const pretty = (v: unknown): string => {
  if (typeof v !== "string") return JSON.stringify(v, null, 2);
  const t = v.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not json */
    }
  }
  return v;
};

/** A case's overall status for scanning: a crashed drive or an unjudged case outranks its band. */
const statusOf = (c: Case): string => (!c.verdict ? "unjudged" : c.drive.errored ? "crashed" : c.verdict.band);
const statusCls: Record<string, string> = { strong: "b-strong", pass: "b-pass", fail: "b-fail", crashed: "b-fail", unjudged: "b-missed" };
const statusBadge = (c: Case) => `<span class="badge ${statusCls[statusOf(c)]}">${statusOf(c)}</span>`;
const bandBadge = (v: Case["verdict"]) => (v ? `<span class="badge ${bandCls[v.band]}">${esc(v.band)}</span>` : `<span class="badge b-missed">unjudged</span>`);

export function renderProofHtmlBundle(r: ProofResults, transcripts: Record<string, Stamped[]>): Record<string, string> {
  const total = r.cases.length;
  const sc = { strong: 0, pass: 0, fail: 0, unjudged: 0, crashed: 0 };
  for (const c of r.cases) {
    if (c.drive.errored) sc.crashed++;
    if (!c.verdict) sc.unjudged++;
    else sc[c.verdict.band]++;
  }
  const runAt = esc(r.runAt.slice(0, 19).replace("T", " "));
  const clean = sc.fail === 0 && sc.crashed === 0 && sc.unjudged === 0 && r.install.ok;

  const shell = (title: string, rel: string, on: string | null, body: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="${rel}styles.css"></head><body>
<header class="nav"><div class="container navrow"><a class="brand" href="${rel}index.html">BuildEx <span class="e">E2E&nbsp;Proof</span></a><nav class="links"><a href="${rel}index.html"${on === "overview" ? ' class="on"' : ""}>Overview</a><a href="${rel}matrix.html"${on === "matrix" ? ' class="on"' : ""}>Test&nbsp;plan</a><a href="${rel}findings.html"${on === "findings" ? ' class="on"' : ""}>Findings</a></nav></div></header>
<main class="container">${body}
<footer class="foot">BuildEx e2e proof track · run ${runAt} · pack <code>${esc(r.pack)}</code> · rendered deterministically from <code>proof-results.json</code> (zero LLM) · local artifact — contains live data, do not share casually.</footer>
</main></body></html>`;

  const out: Record<string, string> = {};

  // ---- index (overview) ----------------------------------------------------
  const verdict = clean
    ? `BuildEx installed the <code>${esc(r.pack)}</code> pack, activated its live MCP connection, and let the real agent work through ${r.surface.tools.length} of the provider's tools across <strong>${total}</strong> generated day-in-the-life scenarios — each judged in a clean room by an independent judge. <strong>${sc.strong} strong, ${sc.pass} pass</strong>, no failures, no crashes; install verified. Every scenario's transcript is on its case page.`
    : `${total} scenarios — ${sc.strong} strong, ${sc.pass} pass, ${sc.fail} fail, ${sc.unjudged} unjudged, ${sc.crashed} crashed${r.install.ok ? "" : "; <strong>install verification FAILED</strong>"}. See the flagged cases and the test plan.`;
  const tiles = [
    ["cases", total, ""], ["strong", sc.strong, "green"], ["pass", sc.pass, "brand"],
    ...(sc.fail ? [["fail", sc.fail, "red"] as const] : []),
    ...(sc.unjudged ? [["unjudged", sc.unjudged, "amber"] as const] : []),
    ...(sc.crashed ? [["crashed", sc.crashed, "red"] as const] : []),
    ["skills", r.surface.skills.length, ""], ["live tools", r.surface.tools.length, ""],
    ["install", r.install.ok ? "✓" : "✗", r.install.ok ? "green" : "red"],
  ].map(([l, n, c]) => `<div class="stat${c ? " " + c : ""}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");
  const srow = (c: Case) =>
    `<a class="srow" href="cases/${esc(c.case.id)}.html">${statusBadge(c)}<span class="snm">${esc(c.case.title)}</span>${kindBadge(c.case.kind)}<span class="sd">${esc(first(c.verdict ? c.verdict.reasoning : c.case.expected, 130))}</span></a>`;
  const groups: [string, Case[]][] = [
    ["Needs attention", r.cases.filter((c) => ["fail", "crashed", "unjudged"].includes(statusOf(c)))],
    ["Pass", r.cases.filter((c) => statusOf(c) === "pass")],
    ["Strong", r.cases.filter((c) => statusOf(c) === "strong")],
  ];
  const scenarioIndex = groups
    .filter(([, cs]) => cs.length)
    .map(([label, cs]) => `<div class="sgroup"><h3>${label} <span class="ct">${cs.length}</span></h3><div class="slist">${cs.map(srow).join("")}</div></div>`)
    .join("");
  out["index.html"] = shell(`Proof run — ${r.pack}`, "", "overview", `
<section class="hero"><h1>Proof run — ${esc(r.pack)}</h1><p class="sub">run ${runAt} · ${total} scenarios · local artifact (not committed)</p>
<div class="verdict">${verdict}</div></section>
<div class="stats">${tiles}</div>
<h2>Documents</h2><div class="cards">
<a class="card big" href="matrix.html"><div class="t">Test plan &amp; matrix</div><div class="d">The surface under test, the generated scenario matrix with per-case acceptance criteria, and how the judge scores.</div></a>
<a class="card" href="findings.html"><div class="t">Findings</div><div class="d">Crashes, functional, non-functional, product-UX, and strengths — aggregated across every scenario.</div></a></div>
<h2>Scenarios</h2>${scenarioIndex}
<h2>Raw data</h2><p>The machine-readable output every page is built from: <a href="proof-results.json">proof-results.json</a>.</p>`);

  // ---- matrix (test plan) --------------------------------------------------
  const skillRows = r.surface.skills.map((s) => `<tr><td><code>${esc(s.name)}</code></td><td>${esc(s.description)}</td></tr>`).join("");
  const toolRows = r.surface.tools.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td>${esc(t.description)}</td></tr>`).join("");
  const matrixRows = r.cases
    .map((c, i) => `<tr><td>${i + 1}</td><td><a href="cases/${esc(c.case.id)}.html">${esc(c.case.title)}</a></td><td>${kindBadge(c.case.kind)}</td><td>${statusBadge(c)}</td><td>${esc(c.case.expected)}</td><td><ul class="tdq">${c.case.disqualifiers.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></td></tr>`)
    .join("");
  out["matrix.html"] = shell(`Test plan — ${r.pack}`, "", "matrix", `
<p class="crumb"><a href="index.html">← Overview</a></p><h1>Test plan &amp; matrix</h1>
<p class="sub">Generated at run time from the pack's discovered surface — nothing hardcoded. The agent that wrote these scenarios saw the skills and tools below and only those.</p>
<h2>Surface under test</h2>
<p>What BuildEx installed and exposed to the agent for this run: the pack's skills (the verbs it teaches) and its live MCP tools (discovered from the running provider, not a fixture).</p>
<h3>Skills <span class="muted">(${r.surface.skills.length})</span></h3><div class="tablewrap"><table class="t2"><thead><tr><th>Skill</th><th>What it teaches</th></tr></thead><tbody>${skillRows}</tbody></table></div>
<h3>Live MCP tools <span class="muted">(${r.surface.tools.length})</span></h3><div class="tablewrap"><table class="t2"><thead><tr><th>Tool</th><th>Description (from the live server)</th></tr></thead><tbody>${toolRows}</tbody></table></div>
<h2>Scenario matrix</h2>
<p>${total} day-in-the-life scenarios were generated from that surface — a mix of happy-path and <span class="badge b-edge">edge</span> cases (at least one edge is required). Each row is a test: its prompt drives the agent, and the judge scores the run against the <em>expected result</em> and the <em>disqualifiers</em>.</p>
<div class="tablewrap"><table class="tm"><thead><tr><th>#</th><th>Scenario</th><th>Kind</th><th>Band</th><th>Expected result</th><th>Disqualifiers</th></tr></thead><tbody>${matrixRows}</tbody></table></div>
<h2>How the judge scores — acceptance criteria</h2>
<p>Each scenario runs in its own clean-room workspace; an independent judge (fresh agent, read-only, sees only the case spec and the transcript) scores it into one band and must cite the transcript events its verdict rests on:</p>
<ul>
<li><span class="badge b-strong">strong</span> — the expected result was met, no disqualifier was tripped, and no tool failure was papered over by fabrication.</li>
<li><span class="badge b-pass">pass</span> — the expected result was met, but with rough edges (retries, detours, partial formatting).</li>
<li><span class="badge b-fail">fail</span> — the expected result was not met, or any disqualifier was tripped.</li>
</ul>
<p>The whole run <strong>passes</strong> (exit 0) only when the install verified, no drive crashed, no scenario scored <span class="badge b-fail">fail</span>, and every scenario was judged.</p>`);

  // ---- findings ------------------------------------------------------------
  const bucketList = (bucket: string) => {
    const it: string[] = [];
    for (const c of r.cases) for (const f of c.verdict?.findings ?? []) if (f.bucket === bucket) it.push(`<li><a href="cases/${esc(c.case.id)}.html">${esc(c.case.title)}</a> — ${esc(f.note)}</li>`);
    if (bucket === "crashes") for (const c of r.cases) if (c.drive.errored) it.push(`<li><a href="cases/${esc(c.case.id)}.html">${esc(c.case.title)}</a> — agent run errored (toolFailures: ${c.drive.toolFailures})</li>`);
    return it.length ? `<ul>${it.join("")}</ul>` : `<p class="muted">— none —</p>`;
  };
  const strengths = (() => {
    const it: string[] = [];
    for (const c of r.cases) for (const f of c.verdict?.findings ?? []) if (f.bucket === "strengths") it.push(`<li><a href="cases/${esc(c.case.id)}.html">${esc(c.case.title)}</a> — ${esc(f.note)}</li>`);
    return it.length ? `<ul>${it.join("")}</ul>` : `<p class="muted">— none —</p>`;
  })();
  const installBlock = r.install.ok
    ? `<p><span class="badge b-strong">verified</span> App, all ${r.install.skills.length} skills, and policy fragment installed.</p>`
    : `<ul class="bad-list">${!r.install.app ? "<li>app manifest missing</li>" : ""}${r.install.skills.filter((s) => !s.present).map((s) => `<li>missing skill: <code>${esc(s.name)}</code></li>`).join("")}${!r.install.policyFragment ? "<li>policy fragment missing</li>" : ""}</ul>`;
  const driftBlock = !r.drift
    ? `<p class="muted">No baseline provided — drift not computed.</p>`
    : r.drift.clean
      ? `<p><span class="badge b-strong">clean</span> No surface drift against the baseline.</p>`
      : `<ul>${(["addedSkills", "removedSkills", "addedTools", "removedTools"] as const).map((k) => (r.drift![k].length ? `<li><strong>${esc(k)}:</strong> ${r.drift![k].map(esc).join(", ")}</li>` : "")).join("")}</ul>`;
  out["findings.html"] = shell(`Findings — ${r.pack}`, "", "findings", `
<p class="crumb"><a href="index.html">← Overview</a></p><h1>Findings</h1>
<p class="sub">What the judge surfaced across all ${total} scenarios, bucketed. Each item links to the scenario it came from — open it for the transcript.</p>
<h2>Install</h2>${installBlock}
<h2>Crashes <span class="muted">— highest severity</span></h2>${bucketList("crashes")}
<h2>Functional</h2>${bucketList("functional")}
<h2>Non-functional</h2>${bucketList("non-functional")}
<h2>Product / UX</h2>${bucketList("product-ux")}
<h2>Strengths</h2>${strengths}
<h2>Surface drift</h2>${driftBlock}`);

  // ---- case pages ----------------------------------------------------------
  for (const c of r.cases) {
    const v = c.verdict;
    const events = transcripts[c.case.id] ?? [];
    const cited = new Set(v?.evidence ?? []);
    const rows = events
      .map((e, i) => {
        const cd = cited.has(i) ? " cited" : "";
        const idx = `<span class="ei">${i}</span>`;
        if (e.kind === "text" || e.kind === "thinking") return `<div class="ev txt${cd}">${idx}<div class="evbody">${esc(e.text)}</div></div>`;
        if (e.kind === "tool") return `<div class="ev tool${cd}">${idx}<div class="evbody"><span class="arrow">▸ call</span> <code>${esc(e.name)}</code>${e.input !== undefined ? `<pre>${esc(pretty(e.input))}</pre>` : ""}</div></div>`;
        if (e.kind === "tool_result") {
          let o = pretty(e.output);
          if (o && o.length > 4000) o = o.slice(0, 4000) + "\n…(truncated)";
          return `<div class="ev result${cd}">${idx}<div class="evbody"><span class="arrow">◂ result</span> <code>${esc(e.name)}</code> ${e.ok ? '<span class="ok">ok</span>' : '<span class="bad">failed</span>'}${o ? `<pre>${esc(o)}</pre>` : ""}</div></div>`;
        }
        if (e.kind === "error") return `<div class="ev err${cd}">${idx}<div class="evbody"><strong>error:</strong> ${esc(e.message)}</div></div>`;
        if (e.kind === "done") return `<div class="ev done${cd}">${idx}<div class="evbody">— turn complete —</div></div>`;
        return "";
      })
      .join("");
    const dq = c.case.disqualifiers.map((d) => `<li>${esc(d)}</li>`).join("");
    out[`cases/${c.case.id}.html`] = shell(`${c.case.title} — ${r.pack}`, "../", null, `
<p class="crumb"><a href="../matrix.html">← Test plan</a> · <a href="../index.html">Overview</a></p>
<h1>${esc(c.case.title)}</h1><p class="sub">${kindBadge(c.case.kind)} ${bandBadge(v)} · ${c.drive.toolCalls} tool calls · ${c.drive.toolFailures} failures · ${c.drive.errored ? "errored" : "clean"}</p>
<h2>Scenario</h2>
<blockquote>${esc(c.case.prompt)}</blockquote>
<p><strong>Expected result.</strong> ${esc(c.case.expected)}</p>
<p><strong>Disqualifiers.</strong></p><ul>${dq}</ul>
<h2>Verdict</h2>
${v ? `<div class="verdict">${esc(v.reasoning)}</div><p class="muted">Cited evidence: events ${v.evidence.join(", ")} — highlighted below.</p>` : `<div class="verdict warn">Unjudged — the judge itself failed to return a valid verdict for this case (its two attempts did not parse). This is a judge failure, not a pack failure; the raw transcript is below.</div>`}
<h2>Transcript</h2>
<details class="transcript"><summary>Full transcript — ${events.length} events${v?.evidence.length ? ` (cited evidence highlighted: ${v.evidence.join(", ")})` : ""}</summary><div class="evlist">${rows}</div></details>`);
  }

  out["styles.css"] = STYLES;
  return out;
}

const STYLES = `:root{
--bg:#292929;--card:#303030;--card2:#373737;--elevate:#424242;--ink:#fbfbfb;--muted:#b4b4b4;--faint:#8b8b8b;
--line:#414141;--line2:#525252;--brand:#2dd4bf;--brand-dim:#1f6f66;--brand-tint:#2b4a46;
--good:#4ade80;--good-tint:rgba(74,222,128,.14);--amber:#f0a94b;--amber-tint:#463a29;--crit:#f87171;--crit-tint:rgba(248,113,113,.14);
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 var(--sans);}
.container{max-width:960px;margin:0 auto;padding:0 22px;}
.nav{position:sticky;top:0;z-index:10;background:var(--card);border-bottom:1px solid var(--line);}
.navrow{display:flex;align-items:center;justify-content:space-between;height:56px;gap:12px;}
.brand{font-weight:700;color:var(--ink);text-decoration:none;font-size:15px;} .brand .e{color:var(--brand);}
.links a{color:var(--muted);text-decoration:none;margin-left:18px;font-size:14px;font-weight:500;}
.links a:hover,.links a.on{color:var(--brand);}
main.container{padding-top:26px;padding-bottom:50px;}
h1{font-size:29px;line-height:1.2;margin:.1em 0 .4em;letter-spacing:-.01em;}
h2{font-size:19px;margin:1.8em 0 .6em;padding-bottom:.3em;border-bottom:1px solid var(--line);}
h2 .muted{font-size:14px;font-weight:400;}
h3{font-size:16px;margin:1.4em 0 .5em;}
p{margin:.7em 0;} a{color:var(--brand);} .muted{color:var(--muted);} .sub{color:var(--muted);font-size:14.5px;margin:-.2em 0 1em;}
.crumb{font-size:13px;margin:0 0 8px;}
code{background:var(--card2);padding:.1em .42em;border-radius:4px;font:13px/1.4 var(--mono);color:#e8e8e8;word-break:break-word;}
pre{background:#1e1e22;color:#e6e6e6;padding:12px 14px;border-radius:8px;margin:.5em 0 0;font:12.5px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}
blockquote{margin:1em 0;padding:.7em 1em;border-left:3px solid var(--brand);background:var(--brand-tint);border-radius:0 6px 6px 0;}
blockquote p{margin:.2em 0;}
ul{padding-left:1.3em;margin:.5em 0;} li{margin:.35em 0;}
.tablewrap{overflow-x:auto;}
table{border-collapse:collapse;width:100%;table-layout:fixed;margin:.9em 0;font-size:14px;box-shadow:0 0 0 1px var(--line);border-radius:8px;overflow:hidden;}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere;word-break:normal;}
th{background:var(--brand-tint);color:var(--ink);font-weight:600;}
td code{background:none;padding:0;color:var(--brand);}
tbody tr:nth-child(even){background:#2c2c2c;}
tr:last-child td{border-bottom:none;}
.t2 th:first-child,.t2 td:first-child{width:190px;}
.tm th:nth-child(1),.tm td:nth-child(1){width:46px;text-align:right;color:var(--faint);white-space:nowrap;}
.tm th:nth-child(2),.tm td:nth-child(2){width:17%;}
.tm th:nth-child(3),.tm td:nth-child(3){width:78px;}
.tm th:nth-child(4),.tm td:nth-child(4){width:86px;}
ul.tdq{margin:0;padding-left:1.1em;} ul.tdq li{margin:.1em 0;font-size:13px;}
.badge{display:inline-block;padding:.1em .55em;border-radius:20px;font-size:11.5px;font-weight:700;letter-spacing:.02em;vertical-align:middle;text-transform:uppercase;white-space:nowrap;}
.b-strong{background:var(--good-tint);color:var(--good);} .b-pass{background:var(--brand-tint);color:var(--brand);}
.b-fail{background:var(--crit-tint);color:var(--crit);} .b-missed{background:var(--amber-tint);color:var(--amber);}
.b-edge{background:var(--amber-tint);color:var(--amber);} .b-happy{background:var(--card2);color:var(--muted);}
.verdict{font-size:15px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--brand);border-radius:8px;padding:14px 16px;margin:12px 0 4px;}
.verdict.warn{border-left-color:var(--amber);}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:12px;margin:22px 0;}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 10px;text-align:center;}
.stat .n{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;} .stat .l{font-size:11px;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:.04em;}
.stat.green .n{color:var(--good);} .stat.brand .n{color:var(--brand);} .stat.red .n{color:var(--crit);} .stat.amber .n{color:var(--amber);}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;margin:14px 0;}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;text-decoration:none;color:var(--ink);transition:.15s;}
.card:hover{border-color:var(--brand);box-shadow:0 4px 16px rgba(45,212,191,.12);transform:translateY(-1px);}
.card .t{font-weight:700;font-size:15.5px;} .card .m{margin:8px 0;} .card .d{color:var(--muted);font-size:13.5px;margin-top:5px;line-height:1.5;}
.big{border-left:3px solid var(--brand);}
.sgroup h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;margin:20px 0 8px;border:none;padding:0;}
.sgroup h3 .ct{color:var(--faint);}
.slist{border:1px solid var(--line);border-radius:8px;overflow:hidden;}
.srow{display:flex;align-items:center;gap:11px;padding:10px 14px;text-decoration:none;color:var(--ink);border-top:1px solid var(--line);}
.srow:first-child{border-top:none;} .srow:hover{background:var(--card2);}
.srow .badge{flex:0 0 auto;}
.srow .snm{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:14px;}
.srow .sd{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:13px;}
details.transcript{border:1px solid var(--line);border-radius:8px;background:var(--card);margin-top:8px;}
details.transcript>summary{cursor:pointer;font-weight:600;color:var(--brand);padding:12px 16px;font-size:14px;}
details.transcript[open]>summary{border-bottom:1px solid var(--line);}
.evlist{margin:8px 10px;}
.ev{display:grid;grid-template-columns:32px minmax(0,1fr);gap:10px;padding:8px 10px;border-radius:6px;font-size:14px;margin:2px 0;}
.ev .ei{color:var(--faint);font:11px var(--mono);text-align:right;padding-top:3px;} .ev .evbody{min-width:0;}
.ev.txt .evbody{white-space:pre-wrap;}
.ev.tool{background:#2f2f34;} .ev.result{background:#23291f;}
.ev.cited{box-shadow:inset 3px 0 0 var(--amber);background:var(--amber-tint);}
.ev .arrow{font-weight:700;color:var(--brand);font-size:12.5px;} .ev.result .arrow{color:var(--good);}
.ev .ok{color:var(--good);font-weight:600;font-size:12px;} .ev .bad{color:var(--crit);font-weight:600;font-size:12px;}
.ev.err{background:var(--crit-tint);} .ev.done .evbody{color:var(--faint);font-style:italic;}
.bad-list li{color:var(--crit);}
.foot{color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);padding-top:16px;margin-top:44px;padding-bottom:36px;}`;
