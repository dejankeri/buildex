// Zero-LLM aggregation and rendering of one proof run (invariant 9: trust surfaces are
// deterministic). Takes the driven cases plus judge verdicts and produces the run's scorecard and
// its report.md - pure string building, no fs and no clock (runAt arrives already stamped on
// ProofResults; the composition step owns writing the file). Rendering is plain markdown lists only
// (no tables) so the artifact diffs cleanly run-to-run.
import type { ProofCase } from "./scenario-step.js";
import type { Verdict } from "./judge-step.js";
import { diffSurface, type Surface } from "./discover.js";
import type { InstallCheck } from "./install-step.js";

export interface ProofResults {
  runAt: string;
  pack: string;
  cases: {
    case: ProofCase;
    drive: { toolCalls: number; toolFailures: number; errored: boolean };
    /** null = the judge itself failed (both attempts) or never ran - reported as unjudged, a
     *  verdict is never invented to fill the gap. */
    verdict: Verdict | null;
  }[];
  surface: Surface;
  drift: ReturnType<typeof diffSurface> | null;
  /** verifyInstall's result for this run - so an all-green report can never silently exit 1 with no
   *  recorded reason (invariant 9: the surviving artifacts must name every gate that mattered). */
  install: InstallCheck;
}

export interface Scorecard {
  strong: number;
  pass: number;
  fail: number;
  unjudged: number;
  crashed: number;
}

/** Count each case toward exactly one of strong/pass/fail (from its verdict's band) or toward
 *  `unjudged` when verdict is null - the judge failing is reported, never invented into a band.
 *  `crashed` is counted independently, from drive.errored alone: a case can be BOTH crashed and
 *  unjudged (the judge ran anyway on a crashed transcript) or BOTH crashed and judged, so this is
 *  a second, unconditional check per case rather than an else-branch off the band count. */
export function computeScorecard(r: ProofResults): Scorecard {
  const sc: Scorecard = { strong: 0, pass: 0, fail: 0, unjudged: 0, crashed: 0 };
  for (const c of r.cases) {
    if (c.verdict === null) sc.unjudged++;
    else sc[c.verdict.band]++;
    if (c.drive.errored) sc.crashed++;
  }
  return sc;
}

const BUCKET_ORDER = ["crashes", "functional", "non-functional", "product-ux", "strengths"] as const;

/** Collapse newlines and neutralize markdown/HTML structure in text.
 *  (a) Replace any whitespace run containing a newline with a single space.
 *  (b) Trim.
 *  (c) If the result starts with a markdown structure token (#, -, *, >, or ```), prefix \.
 *  (d) Escape every `[` as `\[` and every `<` as `&lt;`, everywhere in the text - not just leading.
 *  Routes LLM-produced free-text through one safe inline format, preventing newlines from
 *  injecting document structure (fake headings, list items, blockquotes, code fences) AND
 *  preventing inline markdown (`[text](url)`, `![](url)` image beacons) or raw HTML (`<...>`)
 *  from surviving as live markup when report.md is rendered by any downstream viewer. */
function inline(text: string): string {
  // Collapse whitespace runs containing newlines into a single space.
  let result = text.replace(/\s*\n\s*/g, " ").trim();
  // Escape markdown structure tokens at the start.
  if (/^[#\-*>`]/.test(result) || result.startsWith("```")) {
    result = "\\" + result;
  }
  // Neutralize inline links/images and raw HTML anywhere in the text.
  result = result.replace(/\[/g, "\\[").replace(/</g, "&lt;");
  return result;
}

/** `count` repeated `█` characters followed by the count, or a bare `0` (no bar at all) when the
 *  count is zero - a zero-width bar would be invisible, the bare number is the honest rendering. */
function scoreLine(label: string, count: number): string {
  return count === 0 ? `${label} 0` : `${label} ${"█".repeat(count)} ${count}`;
}

/** Every entry that belongs under one Findings bucket heading, in report order. For `crashes`
 *  specifically: one auto-generated entry per errored drive comes FIRST (so a crash is reported
 *  even when the judge's findings never mention it - the judge can fail or omit it, the drive's
 *  own errored flag cannot lie), followed by whatever the judge itself filed under "crashes". Every
 *  other bucket is exactly the judge's findings for that bucket, case order, finding order. */
function bucketEntries(r: ProofResults, bucket: (typeof BUCKET_ORDER)[number]): string[] {
  const entries: string[] = [];
  if (bucket === "crashes") {
    for (const c of r.cases) {
      if (c.drive.errored) {
        entries.push(`case ${c.case.id}: agent run errored (toolFailures: ${c.drive.toolFailures})`);
      }
    }
  }
  for (const c of r.cases) {
    if (!c.verdict) continue;
    for (const f of c.verdict.findings) {
      if (f.bucket === bucket) entries.push(`case ${c.case.id}: ${inline(f.note)}`);
    }
  }
  return entries;
}

/** Render the run's report.md: header, scorecard bars, the Findings buckets (fixed order, every
 *  heading always present, auto-crash inclusion), one Cases section per case, the surface-drift
 *  section, and the fixed provider-state deferral footer. Deterministic string building only - the
 *  same ProofResults always renders byte-identical markdown. */
export function renderProofReport(r: ProofResults): string {
  const sc = computeScorecard(r);
  const lines: string[] = [];

  lines.push(`# Proof run — ${r.pack}`);
  lines.push(`runAt: ${r.runAt}`);
  lines.push("");
  lines.push("## Scorecard");
  lines.push(scoreLine("strong", sc.strong));
  lines.push(scoreLine("pass", sc.pass));
  lines.push(scoreLine("fail", sc.fail));
  lines.push(scoreLine("unjudged", sc.unjudged));
  lines.push(scoreLine("crashed", sc.crashed));
  lines.push("");

  // Install verification, always rendered (even when ok) - a run can exit non-zero purely on a
  // broken install (proof.ts's `check?.ok === false ? false : ...`), and prior to this section
  // that reason never made it into either surviving artifact.
  lines.push("## Install");
  lines.push(`- ok: ${r.install.ok}`);
  if (!r.install.ok) {
    if (!r.install.app) lines.push("- app: false");
    for (const s of r.install.skills) {
      if (!s.present) lines.push(`- missing skill: ${s.name}`);
    }
    if (!r.install.policyFragment) lines.push("- policyFragment: false");
  }
  lines.push("");

  lines.push("## Findings");
  for (const bucket of BUCKET_ORDER) {
    lines.push(`### ${bucket}`);
    const entries = bucketEntries(r, bucket);
    if (entries.length === 0) lines.push("- none");
    else for (const e of entries) lines.push(`- ${e}`);
    lines.push("");
  }

  lines.push("## Cases");
  for (const c of r.cases) {
    lines.push(`### ${c.case.id} — ${inline(c.case.title)}`);
    lines.push(`kind: ${c.case.kind}`);
    lines.push(`band: ${c.verdict ? c.verdict.band : "unjudged"}`);
    lines.push(`reasoning: ${c.verdict ? inline(c.verdict.reasoning) : "(unjudged - no verdict)"}`);
    lines.push(`evidence: [${c.verdict ? c.verdict.evidence.join(", ") : ""}]`);
    lines.push(`expected: ${inline(c.case.expected)}`);
    lines.push("disqualifiers:");
    for (const d of c.case.disqualifiers) lines.push(`- ${inline(d)}`);
    lines.push(`drive: toolCalls=${c.drive.toolCalls} toolFailures=${c.drive.toolFailures} errored=${c.drive.errored}`);
    lines.push("");
  }

  lines.push("## Surface drift");
  if (r.drift === null) {
    lines.push("- no baseline provided");
  } else if (r.drift.clean) {
    lines.push("- clean (no drift)");
  } else {
    const sections: [string, string[]][] = [
      ["added skills", r.drift.addedSkills],
      ["removed skills", r.drift.removedSkills],
      ["added tools", r.drift.addedTools],
      ["removed tools", r.drift.removedTools],
    ];
    for (const [label, items] of sections) {
      if (items.length === 0) continue;
      lines.push(`### ${label}`);
      for (const item of items) lines.push(`- ${inline(item)}`);
    }
  }
  lines.push("");

  lines.push("provider-state verification: not run (deferred to the deployed lane)");

  return lines.join("\n") + "\n";
}
