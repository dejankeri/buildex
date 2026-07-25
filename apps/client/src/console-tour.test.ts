// The guided tour, checked against the UI it claims to describe.
//
// The tour is uniquely prone to silent rot. collectTourSteps() drops any step whose anchor is
// missing, which keeps the tour from breaking when the UI changes - and also means a renamed region
// makes its step disappear with no error, and stale body copy survives forever because nothing reads
// it. That is exactly what happened: the right-panel step told operators to "switch it between
// Pending approvals, Files, and Skills" long after that rail became Brain / Documents / Loops.
//
// These tests read the REAL index.html through the harness, so they fail when the UI moves rather
// than when someone forgets to update a fixture.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

/** The right-panel tabs as the markup actually defines them, e.g. ["brain","documents","loops"].
 *  Typed off the harness handle - this package has no DOM lib, so `Document` is not a type here. */
type Doc = ReturnType<typeof loadConsole>["doc"];
function realRightPanels(doc: Doc): string[] {
  // Array.from, not spread: the harness types querySelectorAll as ArrayLike, which is not iterable.
  return Array.from(doc.querySelectorAll("#rtabs button[data-r]"), (b) => String(b.getAttribute("data-r")));
}

describe("console (jsdom) - the guided tour describes the UI that exists", () => {
  it("anchors every step to a region actually present in the console", () => {
    const { doc, c } = loadConsole();
    const defined = c.tourStepDefs() as { sel: string; alt?: string; title: string }[];
    const missing = defined.filter((s) => !doc.querySelector(s.sel) && !(s.alt && doc.querySelector(s.alt)));
    // A missing anchor is not a crash - the step is silently dropped, so the operator just never
    // hears about that part of the app. Fail loudly here instead.
    expect(missing.map((s) => `${s.title} (${s.sel})`)).toEqual([]);
    expect((c.collectTourSteps() as unknown[]).length).toBe(defined.length);
  });

  it("names the right panel's real tabs, not the ones it used to have", () => {
    const { doc, c } = loadConsole();
    const defined = c.tourStepDefs() as { sel: string; body: string }[];
    const step = defined.find((s) => s.sel === "#rtabs");
    expect(step, "the tour must still have a right-panel step").toBeDefined();

    // The copy marks panel NAMES by bolding them, so read the bolded tokens rather than searching
    // the whole sentence - "your files and connected drives" is prose about Documents, not a claim
    // that a Files tab exists, and a substring check cannot tell those apart.
    const bolded = [...step!.body.matchAll(/<b>(.*?)<\/b>/g)].map((m) => m[1]!.toLowerCase());

    for (const panel of realRightPanels(doc)) {
      expect(bolded, `right-panel step must name "${panel}" as a panel`).toContain(panel);
    }
    // Retired rail names must no longer be presented as panels. "Pending" is the sharpest:
    // approvals now ride the Brain icon's badge, so pointing at a Pending tab sends them nowhere.
    for (const retired of ["pending", "files", "skills"]) {
      expect(bolded, `right-panel step must not still offer a "${retired}" panel`).not.toContain(retired);
    }
  });

  it("uses only markup the tour renderer supports (bold only - bodies are set as innerHTML)", () => {
    const { c } = loadConsole();
    for (const s of c.tourStepDefs() as { title: string; body: string }[]) {
      // Bodies are author-written trusted strings injected with innerHTML; keep them to <b> so no
      // one is tempted to grow this into arbitrary markup with operator content in it.
      const tags = [...s.body.matchAll(/<\/?([a-z]+)/g)].map((m) => m[1]);
      expect([...new Set(tags)].sort(), `unexpected markup in "${s.title}"`).toEqual(
        tags.length ? ["b"] : [],
      );
    }
  });
});
