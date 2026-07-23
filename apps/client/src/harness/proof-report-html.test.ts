import { describe, it, expect } from "vitest";
import { renderProofHtmlBundle } from "./proof-report-html.js";
import type { ProofResults } from "./proof-report.js";
import type { UiEvent } from "../agent/types.js";

type Stamped = UiEvent & { at?: string };

function results(cases: ProofResults["cases"], over: Partial<ProofResults> = {}): ProofResults {
  return {
    runAt: "2026-07-23T20:00:00.000Z",
    pack: "acme",
    install: { app: true, skills: [{ name: "acme-howto", present: true }], policyFragment: true, ok: true },
    cases,
    surface: { pack: "acme", skills: [{ name: "acme-howto", description: "does a thing" }], tools: [{ name: "find", description: "search" }] },
    drift: null,
    ...over,
  };
}
const strongCase = (id: string, title = `Title ${id}`) => ({
  case: { id, title, kind: "happy" as const, prompt: "do it", expected: "it is done", disqualifiers: ["fabricates"] },
  drive: { toolCalls: 2, toolFailures: 0, errored: false },
  verdict: { caseId: id, band: "strong" as const, reasoning: "met cleanly", evidence: [1], findings: [{ bucket: "strengths" as const, note: "cited records" }] },
});
const failCase = (id: string) => ({
  case: { id, title: `Fail ${id}`, kind: "edge" as const, prompt: "p", expected: "e", disqualifiers: ["d"] },
  drive: { toolCalls: 1, toolFailures: 1, errored: false },
  verdict: { caseId: id, band: "fail" as const, reasoning: "tripped a disqualifier", evidence: [0], findings: [{ bucket: "functional" as const, note: "wrong entity" }] },
});

describe("renderProofHtmlBundle", () => {
  it("renders the full file set: index, matrix, findings, styles, and one case page per scenario", () => {
    const b = renderProofHtmlBundle(results([strongCase("c1"), strongCase("c2")]), {});
    expect(Object.keys(b).sort()).toEqual(
      ["cases/c1.html", "cases/c2.html", "findings.html", "index.html", "matrix.html", "styles.css"].sort(),
    );
    for (const v of Object.values(b)) expect(typeof v).toBe("string");
    expect(b["index.html"]).toContain("<!doctype html>");
    expect(b["styles.css"]).toContain(":root");
  });

  it("is deterministic — identical input renders byte-identical output", () => {
    const r = results([strongCase("c1"), failCase("c2")]);
    expect(renderProofHtmlBundle(r, {})).toEqual(renderProofHtmlBundle(r, {}));
  });

  it("escapes HTML in scenario + judge text so page structure can't be injected", () => {
    const evil = strongCase("c1", "Morning <script>alert(1)</script> triage");
    const b = renderProofHtmlBundle(results([evil]), {});
    expect(b["index.html"]).toContain("&lt;script&gt;");
    expect(b["index.html"]).not.toContain("<script>alert(1)</script>");
  });

  it("groups the scenario index failures-first (Needs attention before Strong)", () => {
    const b = renderProofHtmlBundle(results([strongCase("s1"), failCase("f1")]), {});
    const idx = b["index.html"]!;
    expect(idx.indexOf(">Needs attention ")).toBeGreaterThan(-1);
    expect(idx.indexOf(">Strong ")).toBeGreaterThan(-1);
    expect(idx.indexOf(">Needs attention ")).toBeLessThan(idx.indexOf(">Strong "));
    // the fail case's status badge is rendered
    expect(idx).toContain("Fail f1");
  });

  it("classifies a crashed drive and an unjudged case as needing attention", () => {
    const crashed = { ...strongCase("c1"), drive: { toolCalls: 1, toolFailures: 1, errored: true } };
    const unjudged = { case: { id: "u1", title: "U", kind: "happy" as const, prompt: "p", expected: "e", disqualifiers: ["d"] }, drive: { toolCalls: 0, toolFailures: 0, errored: false }, verdict: null };
    const b = renderProofHtmlBundle(results([crashed, unjudged]), {});
    expect(b["index.html"]).toContain("crashed");
    expect(b["index.html"]).toContain("unjudged");
  });

  it("renders the matrix with the surface, a band column, and a row per scenario", () => {
    const b = renderProofHtmlBundle(results([strongCase("c1"), failCase("c2")]), {})["matrix.html"]!;
    expect(b).toContain("Surface under test");
    expect(b).toContain("Scenario matrix");
    expect(b).toContain("acme-howto"); // a skill
    expect(b).toContain("<th>Band</th>");
    expect(b).toContain("Title c1");
    expect(b).toContain("Fail c2");
    // acceptance criteria (the real rubric bands)
    expect(b).toContain("acceptance criteria");
  });

  it("renders the transcript on the case page, escaping tool output and highlighting cited events", () => {
    const transcripts: Record<string, Stamped[]> = {
      c1: [
        { kind: "text", text: "working" },
        { kind: "tool", id: "t1", name: "find", input: { q: "x" } },
        { kind: "tool_result", id: "t1", name: "find", ok: true, output: "<b>should be escaped</b> [REDACTED]" },
        { kind: "done" },
      ],
    };
    const page = renderProofHtmlBundle(results([strongCase("c1")]), transcripts)["cases/c1.html"]!;
    expect(page).toContain("&lt;b&gt;should be escaped&lt;/b&gt;");
    expect(page).not.toContain("<b>should be escaped</b>");
    expect(page).toContain("[REDACTED]"); // passes through (redaction happens upstream)
    expect(page).toContain("cited"); // evidence [1] highlights event index 1
  });

  it("scales: N cases produce N case pages", () => {
    const many = Array.from({ length: 30 }, (_, i) => strongCase(`c${i}`));
    const b = renderProofHtmlBundle(results(many), {});
    expect(Object.keys(b).filter((k) => k.startsWith("cases/")).length).toBe(30);
  });

  it("renders install verification failure in findings", () => {
    const r = results([strongCase("c1")], { install: { app: true, skills: [{ name: "acme-howto", present: false }], policyFragment: true, ok: false } });
    expect(renderProofHtmlBundle(r, {})["findings.html"]).toContain("missing skill");
  });
});
