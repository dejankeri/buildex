// Hermetic tests for the proof report: computeScorecard's counting rules (unjudged vs crashed are
// independent, a case can be both) and renderProofReport's deterministic markdown (every bucket
// heading present exactly once in fixed order, auto-crash inclusion, per-case detail, drift
// variants). Assertions are contains/not-contains/counted-occurrences only - never a full-string
// snapshot, so the artifact's exact spacing can evolve without breaking these tests.
import { describe, it, expect } from "vitest";
import { computeScorecard, renderProofReport, type ProofResults } from "./proof-report.js";
import type { ProofCase } from "./scenario-step.js";
import type { Verdict } from "./judge-step.js";
import type { Surface } from "./discover.js";
import type { InstallCheck } from "./install-step.js";

const SURFACE: Surface = { pack: "test-pack", skills: [], tools: [] };

function makeInstall(overrides: Partial<InstallCheck> = {}): InstallCheck {
  return { app: true, skills: [], policyFragment: true, ok: true, ...overrides };
}

function makeCase(id: string, overrides: Partial<ProofCase> = {}): ProofCase {
  return {
    id,
    title: `Title for ${id}`,
    kind: "happy",
    prompt: `Do the thing for ${id}.`,
    expected: `Expected result for ${id}.`,
    disqualifiers: [`Disqualifier A for ${id}`, `Disqualifier B for ${id}`],
    ...overrides,
  };
}

function makeVerdict(caseId: string, overrides: Partial<Verdict> = {}): Verdict {
  return {
    caseId,
    band: "strong",
    reasoning: `Reasoning text for ${caseId}.`,
    evidence: [0, 1],
    findings: [],
    ...overrides,
  };
}

function makeEntry(
  id: string,
  opts: {
    drive?: Partial<{ toolCalls: number; toolFailures: number; errored: boolean }>;
    verdict?: Verdict | null;
    case?: Partial<ProofCase>;
  } = {},
): ProofResults["cases"][number] {
  return {
    case: makeCase(id, opts.case),
    drive: { toolCalls: 1, toolFailures: 0, errored: false, ...opts.drive },
    verdict: opts.verdict === undefined ? makeVerdict(id) : opts.verdict,
  };
}

function makeResults(
  cases: ProofResults["cases"],
  drift: ProofResults["drift"] = null,
  install: InstallCheck = makeInstall(),
): ProofResults {
  return { runAt: "2026-07-23T10:00:00.000Z", pack: "test-pack", cases, surface: SURFACE, drift, install };
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("computeScorecard", () => {
  it("counts each case toward exactly one band, or unjudged when verdict is null", () => {
    const r = makeResults([
      makeEntry("c1", { verdict: makeVerdict("c1", { band: "strong" }) }),
      makeEntry("c2", { verdict: makeVerdict("c2", { band: "pass" }) }),
      makeEntry("c3", { verdict: makeVerdict("c3", { band: "fail" }) }),
      makeEntry("c4", { verdict: null }),
    ]);
    expect(computeScorecard(r)).toEqual({ strong: 1, pass: 1, fail: 1, unjudged: 1, crashed: 0 });
  });

  it("counts crashed independently of judged status - a case can be BOTH crashed and unjudged", () => {
    const r = makeResults([
      // crashed AND unjudged at once
      makeEntry("c1", { drive: { errored: true }, verdict: null }),
      // crashed but still judged (judge ran despite the crash)
      makeEntry("c2", { drive: { errored: true }, verdict: makeVerdict("c2", { band: "strong" }) }),
      // judged, not crashed
      makeEntry("c3", { drive: { errored: false }, verdict: makeVerdict("c3", { band: "fail" }) }),
    ]);
    const sc = computeScorecard(r);
    expect(sc.crashed).toBe(2);
    expect(sc.unjudged).toBe(1);
    expect(sc.strong).toBe(1);
    expect(sc.fail).toBe(1);
  });
});

describe("renderProofReport - header and scorecard", () => {
  it("starts with the pack header and includes the runAt string verbatim, never computing its own clock", () => {
    const r = makeResults([makeEntry("c1")]);
    const md = renderProofReport(r);
    expect(md.startsWith("# Proof run — test-pack")).toBe(true);
    expect(md).toContain("2026-07-23T10:00:00.000Z");
  });

  it("renders a bar of repeated block characters sized to the count, and a bare 0 for empty bands", () => {
    const r = makeResults([
      makeEntry("c1", { verdict: makeVerdict("c1", { band: "strong" }) }),
      makeEntry("c2", { verdict: makeVerdict("c2", { band: "strong" }) }),
      makeEntry("c3", { verdict: makeVerdict("c3", { band: "strong" }) }),
    ]);
    const md = renderProofReport(r);
    expect(md).toContain("███");
    expect(md).toContain("strong");
    // pass/fail/unjudged/crashed are all zero here - each renders as a bare 0, no bar characters.
    expect(md).toMatch(/pass 0(\D|$)/);
    expect(md).toMatch(/fail 0(\D|$)/);
  });
});

describe("renderProofReport - install section", () => {
  it("renders ok: true near the top when install succeeded", () => {
    const r = makeResults([makeEntry("c1")], null, makeInstall({ ok: true }));
    const md = renderProofReport(r);
    expect(md).toContain("## Install");
    expect(md).toContain("- ok: true");
    // Lands after the scorecard, before the Findings section.
    expect(md.indexOf("## Install")).toBeGreaterThan(md.indexOf("## Scorecard"));
    expect(md.indexOf("## Install")).toBeLessThan(md.indexOf("## Findings"));
  });

  it("renders ok: false and lists the missing skill when install failed", () => {
    const r = makeResults(
      [makeEntry("c1")],
      null,
      makeInstall({ ok: false, skills: [{ name: "acme-howto", present: false }] }),
    );
    const md = renderProofReport(r);
    expect(md).toContain("- ok: false");
    expect(md).toContain("- missing skill: acme-howto");
  });

  it("lists app: false and policyFragment: false when those checks failed too", () => {
    const r = makeResults([makeEntry("c1")], null, makeInstall({ ok: false, app: false, policyFragment: false }));
    const md = renderProofReport(r);
    expect(md).toContain("- app: false");
    expect(md).toContain("- policyFragment: false");
  });

  it("omits app/skill/policyFragment detail lines when ok is true", () => {
    const r = makeResults([makeEntry("c1")], null, makeInstall({ ok: true }));
    const md = renderProofReport(r);
    expect(md).not.toContain("- app: false");
    expect(md).not.toContain("- policyFragment: false");
    expect(md).not.toContain("missing skill:");
  });
});

describe("renderProofReport - findings buckets", () => {
  it("always emits all five bucket headings, exactly once each, in fixed order", () => {
    const r = makeResults([makeEntry("c1")]);
    const md = renderProofReport(r);
    for (const bucket of ["crashes", "functional", "non-functional", "product-ux", "strengths"]) {
      expect(occurrences(md, `### ${bucket}`)).toBe(1);
    }
    const idx = (b: string) => md.indexOf(`### ${b}`);
    expect(idx("crashes")).toBeLessThan(idx("functional"));
    expect(idx("functional")).toBeLessThan(idx("non-functional"));
    expect(idx("non-functional")).toBeLessThan(idx("product-ux"));
    expect(idx("product-ux")).toBeLessThan(idx("strengths"));
  });

  it("renders '- none' for every bucket when there are no findings and nothing crashed", () => {
    const r = makeResults([makeEntry("c1", { verdict: makeVerdict("c1", { findings: [] }) })]);
    const md = renderProofReport(r);
    expect(occurrences(md, "- none")).toBe(5);
  });

  it("auto-includes one crashes entry per errored drive even when the judge never flagged a crash", () => {
    const r = makeResults([
      makeEntry("c1", { drive: { errored: true, toolFailures: 2 }, verdict: makeVerdict("c1", { findings: [] }) }),
    ]);
    const md = renderProofReport(r);
    expect(md).toContain("case c1: agent run errored (toolFailures: 2)");
  });

  it("auto-includes the crash entry even when the case is unjudged (verdict null)", () => {
    const r = makeResults([makeEntry("c1", { drive: { errored: true, toolFailures: 0 }, verdict: null })]);
    const md = renderProofReport(r);
    expect(md).toContain("case c1: agent run errored (toolFailures: 0)");
  });

  it("appends the judge's own crashes-bucket findings after the auto-generated entry", () => {
    const r = makeResults([
      makeEntry("c1", {
        drive: { errored: true, toolFailures: 1 },
        verdict: makeVerdict("c1", { findings: [{ bucket: "crashes", note: "Agent kept retrying the same failing tool." }] }),
      }),
    ]);
    const md = renderProofReport(r);
    const autoIdx = md.indexOf("case c1: agent run errored (toolFailures: 1)");
    const judgeIdx = md.indexOf("Agent kept retrying the same failing tool.");
    expect(autoIdx).toBeGreaterThan(-1);
    expect(judgeIdx).toBeGreaterThan(autoIdx);
  });

  it("routes each finding bucket to its matching heading only", () => {
    const r = makeResults([
      makeEntry("c1", {
        verdict: makeVerdict("c1", {
          findings: [
            { bucket: "functional", note: "Missed the edge case entirely." },
            { bucket: "product-ux", note: "Confusing phrasing in the final reply." },
          ],
        }),
      }),
    ]);
    const md = renderProofReport(r);
    const functionalIdx = md.indexOf("### functional");
    const nonFunctionalIdx = md.indexOf("### non-functional");
    const productUxIdx = md.indexOf("### product-ux");
    expect(md.indexOf("Missed the edge case entirely.")).toBeGreaterThan(functionalIdx);
    expect(md.indexOf("Missed the edge case entirely.")).toBeLessThan(nonFunctionalIdx);
    expect(md.indexOf("Confusing phrasing in the final reply.")).toBeGreaterThan(productUxIdx);
  });
});

describe("renderProofReport - per-case section", () => {
  it("includes title, kind, band, reasoning, evidence indexes, expected, and disqualifiers for a judged case", () => {
    const r = makeResults([
      makeEntry("find-a-record", {
        case: { title: "Find a record", kind: "edge", expected: "The record is found.", disqualifiers: ["Invents an id"] },
        verdict: makeVerdict("find-a-record", { band: "pass", reasoning: "Rough edges but got there.", evidence: [1, 4] }),
      }),
    ]);
    const md = renderProofReport(r);
    expect(md).toContain("Find a record");
    expect(md).toContain("edge");
    expect(md).toContain("band: pass");
    expect(md).toContain("Rough edges but got there.");
    expect(md).toContain("evidence: [1, 4]");
    expect(md).toContain("The record is found.");
    expect(md).toContain("Invents an id");
  });

  it("renders band 'unjudged' and never invents a verdict when verdict is null", () => {
    const r = makeResults([makeEntry("c1", { verdict: null })]);
    const md = renderProofReport(r);
    expect(md).toContain("band: unjudged");
    expect(md).not.toContain("band: strong");
    expect(md).not.toContain("band: pass");
    expect(md).not.toContain("band: fail");
  });

  it("includes a drive stats line with toolCalls, toolFailures, and errored", () => {
    const r = makeResults([makeEntry("c1", { drive: { toolCalls: 5, toolFailures: 2, errored: true } })]);
    const md = renderProofReport(r);
    expect(md).toContain("toolCalls=5");
    expect(md).toContain("toolFailures=2");
    expect(md).toContain("errored=true");
  });

  it("emits one case section per case, in the given order", () => {
    const r = makeResults([makeEntry("first"), makeEntry("second")]);
    const md = renderProofReport(r);
    expect(md.indexOf("first")).toBeLessThan(md.indexOf("second"));
  });
});

describe("renderProofReport - surface drift", () => {
  it("reports no baseline provided when drift is null, and omits the clean/drift lines", () => {
    const r = makeResults([makeEntry("c1")], null);
    const md = renderProofReport(r);
    expect(md).toContain("## Surface drift");
    expect(md).toContain("no baseline provided");
    expect(md).not.toContain("clean (no drift)");
  });

  it("reports clean when the diff has no changes", () => {
    const r = makeResults(
      [makeEntry("c1")],
      { addedSkills: [], removedSkills: [], addedTools: [], removedTools: [], clean: true },
    );
    const md = renderProofReport(r);
    expect(md).toContain("clean (no drift)");
    expect(md).not.toContain("no baseline provided");
  });

  it("lists only the non-empty drift categories, by name, and collapses a newline-bearing item so it cannot inject a heading", () => {
    const r = makeResults(
      [makeEntry("c1")],
      {
        addedSkills: ["new-skill", "sneaky\n\n### functional\ninjected"],
        removedSkills: [],
        addedTools: ["new-tool"],
        removedTools: [],
        clean: false,
      },
    );
    const md = renderProofReport(r);
    expect(md).toContain("new-skill");
    expect(md).toContain("new-tool");
    expect(md).not.toContain("### removed skills");
    expect(md).not.toContain("### removed tools");
    expect(md).not.toContain("clean (no drift)");
    expect(md).not.toContain("no baseline provided");
    // The newline-bearing drift item is collapsed onto one line - no injected heading line, and only
    // the ONE real "### functional" heading (from the fixed Findings bucket order) survives.
    expect(md).toContain("sneaky ### functional injected");
    expect(md.match(/^### functional$/m)?.length ?? 0).toBe(1);
  });
});

describe("renderProofReport - footer", () => {
  it("always ends with the provider-state deferral line", () => {
    const r = makeResults([makeEntry("c1")]);
    const md = renderProofReport(r);
    expect(md).toContain("provider-state verification: not run (deferred to the deployed lane)");
  });
});

describe("renderProofReport - injection safety (finding notes, titles, reasoning, expected, disqualifiers)", () => {
  it("collapses newlines in finding notes and prevents heading injection", () => {
    const r = makeResults([
      makeEntry("c1", {
        verdict: makeVerdict("c1", {
          findings: [{ bucket: "functional", note: "sneaky\n\n### functional\ninjected" }],
        }),
      }),
    ]);
    const md = renderProofReport(r);
    // Only one line should START with "### functional" (the bucket header heading)
    // The injected text won't create a new heading because it's collapsed onto the same line
    const headingMatches = md.match(/^### functional$/m);
    expect(headingMatches ? headingMatches.length : 0).toBe(1);
    // The collapsed text contains both sneaky and injected on same line (### functional in middle won't create a heading)
    expect(md).toContain("sneaky ### functional injected");
  });

  it("escapes case titles that start with markdown heading syntax", () => {
    const r = makeResults([makeEntry("c1", { case: { title: "# fake heading" } })]);
    const md = renderProofReport(r);
    // The escaped form should be present
    expect(md).toContain("\\# fake heading");
    // A line starting with the unescaped heading should not exist
    expect(md).not.toMatch(/^# fake heading/m);
  });

  it("escapes titles that start with list markers", () => {
    const r = makeResults([makeEntry("c1", { case: { title: "- list item" } })]);
    const md = renderProofReport(r);
    expect(md).toContain("\\- list item");
  });

  it("escapes titles that start with blockquote marker", () => {
    const r = makeResults([makeEntry("c1", { case: { title: "> quote" } })]);
    const md = renderProofReport(r);
    expect(md).toContain("\\> quote");
  });

  it("collapses newlines in case expected field", () => {
    const r = makeResults([makeEntry("c1", { case: { expected: "first line\n\n### injected\nsecond line" } })]);
    const md = renderProofReport(r);
    // Newlines are collapsed to spaces, so we get "first line ### injected second line" on one line
    expect(md).toContain("first line ### injected second line");
  });

  it("collapses newlines and escapes in verdict reasoning", () => {
    const r = makeResults([
      makeEntry("c1", {
        verdict: makeVerdict("c1", { reasoning: "good\n\n# fake\nreasoning" }),
      }),
    ]);
    const md = renderProofReport(r);
    // Newlines collapsed, but # is in the middle so not escaped
    expect(md).toContain("good # fake reasoning");
  });

  it("collapses newlines in disqualifiers", () => {
    const r = makeResults([
      makeEntry("c1", {
        case: { disqualifiers: ["no\n\n- injected", "another\n  collapsed"] },
      }),
    ]);
    const md = renderProofReport(r);
    // Newlines are collapsed to spaces
    expect(md).toContain("no - injected");
    expect(md).toContain("another collapsed");
  });

  it("escapes disqualifiers starting with markdown tokens", () => {
    const r = makeResults([
      makeEntry("c1", {
        case: { disqualifiers: ["- starts with list", "# starts with heading", "> starts with quote"] },
      }),
    ]);
    const md = renderProofReport(r);
    expect(md).toContain("\\- starts with list");
    expect(md).toContain("\\# starts with heading");
    expect(md).toContain("\\> starts with quote");
  });

  it("neutralizes an inline markdown image beacon in a finding note (no live image markup)", () => {
    const r = makeResults([
      makeEntry("c1", {
        verdict: makeVerdict("c1", { findings: [{ bucket: "functional", note: "before ![](http://evil/?x=1) after" }] }),
      }),
    ]);
    const md = renderProofReport(r);
    expect(md).toContain("\\[");
    expect(md).not.toMatch(/!\[\]\(http:\/\/evil/);
  });

  it("escapes a raw HTML tag in a finding note", () => {
    const r = makeResults([
      makeEntry("c1", {
        verdict: makeVerdict("c1", { findings: [{ bucket: "functional", note: "reported <img src=x> in the reply" }] }),
      }),
    ]);
    const md = renderProofReport(r);
    expect(md).toContain("&lt;img");
    expect(md).not.toContain("<img src=x>");
  });
});
