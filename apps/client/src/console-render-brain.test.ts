// Browser test net for the operator console — the Brain view surfaces. Like the sibling
// console-render.test.ts, this loads the REAL bundle into jsdom (see console-harness.ts) and asserts
// renderer DOM output, above all that operator/agent-supplied text (skill names, tool names, pending
// inputs, commit subjects, repo-root names, node labels) is ESCAPED not injected — the security
// property this net exists to guard as the innerHTML→builder migration proceeds.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

// The XSS canary reused across every surface: if it ever becomes a live <img>, escaping regressed.
const XSS = "<img src=x onerror=alert(1)>";

// A representative brain snapshot (the shape loadBrain() stashes on the tab as `tab.brain`).
function snapshot() {
  return {
    conn: [{ connected: true }, { connected: false }], // 1 live connector
    gw: {
      status: [{ connected: true }], // + 1 live gateway source ⇒ sensor = 2
      tools: [
        { name: "gmail__send", kind: "gated" },
        { name: "fs__read", kind: "read" },
        { name: "secret__x", kind: "hidden" }, // hidden ⇒ filtered out
      ],
    },
    pend: [{ tool: { name: "SendEmail", input: { to: "board@acme.co" } } }],
    skills: [{ name: "triage", description: "sort the inbox" }],
    changes: [{ subject: "init brain", author: "ada", at: Date.now() - 1000, sha: "abcdef1234567", files: ["x.md"] }],
    cfg: { company: { name: "Acme" } },
  };
}

describe("console renderers (jsdom) — Brain view", () => {
  it("brainNodes derives the five loop stages with live counts + labels", () => {
    const { c } = loadConsole();
    const nodes = c.brainNodes(snapshot());
    expect(nodes.map((n: { key: string }) => n.key)).toEqual(["sensor", "policy", "tools", "gate", "learning"]);
    expect(nodes[0].count).toBe(2); // 1 connected connector + 1 connected gateway source
    expect(nodes[2].count).toBe(2); // 3 tools minus the 1 hidden one
    expect(nodes[1].sub).toBe("1 verb");
    expect(nodes[3].sub).toBe("1 pending");
  });

  it("renderBrain paints the SVG loop (hub + one node per stage) and the overview rail", () => {
    const { doc, w, c } = loadConsole();
    w.matchMedia = () => ({ matches: true }); // reduced-motion ⇒ startBrainFlow() no-ops (no rAF/getTotalLength)
    const pane = doc.querySelector("#rpanel")!;
    c.renderBrain({ brain: snapshot(), focusKey: "", pane });
    expect(doc.querySelector("#rpanel .bsvg")).not.toBeNull();
    expect(doc.querySelectorAll("#rpanel .bnode")).toHaveLength(6); // 5 stage nodes + the central hub
    expect(doc.querySelector("#rpanel .bhub")).not.toBeNull();
    expect(doc.querySelectorAll("#rpanel .bgrid .bcell")).toHaveLength(5);
    expect(doc.querySelector("#rpanel .bh")!.textContent).toContain("Acme");
  });

  it("renderBrainRail overview lists a cell per stage and a refresh affordance", () => {
    const { doc, c } = loadConsole();
    const host = doc.querySelector("#rpanel")!;
    const tab = { brain: snapshot(), focusKey: "" };
    c.renderBrainRail(tab, host, c.brainNodes(tab.brain));
    expect(doc.querySelectorAll("#rpanel .bcell")).toHaveLength(5);
    expect(doc.querySelector("#rpanel .brefresh")).not.toBeNull();
  });

  it("shows an empty affordance when the gate is clear and when no verbs exist", () => {
    const { doc, c } = loadConsole();
    const host = doc.querySelector("#rpanel")!;
    const empty = { ...snapshot(), pend: [], skills: [] };

    c.renderBrainRail({ brain: empty, focusKey: "gate" }, host, c.brainNodes(empty));
    expect(doc.querySelector("#rpanel .bempty")!.textContent).toContain("All caught up");

    c.renderBrainRail({ brain: empty, focusKey: "policy" }, host, c.brainNodes(empty));
    expect(doc.querySelector("#rpanel .bempty")!.textContent).toContain("No verbs");
  });

  it("ESCAPES a hostile skill name in the Policy rail — inert text, never a live element", () => {
    const { doc, c } = loadConsole();
    const host = doc.querySelector("#rpanel")!;
    const d = { ...snapshot(), skills: [{ name: XSS, description: "x" }] };
    c.renderBrainRail({ brain: d, focusKey: "policy" }, host, c.brainNodes(d));
    expect(doc.querySelector("#rpanel img")).toBeNull(); // payload did NOT become a real element
    expect(doc.querySelector("#rpanel .bcn")!.textContent).toContain("<img"); // survives as visible text
  });

  it("ESCAPES a hostile pending tool name in the Gate rail", () => {
    const { doc, c } = loadConsole();
    const host = doc.querySelector("#rpanel")!;
    const d = { ...snapshot(), pend: [{ tool: { name: XSS, input: {} } }] };
    c.renderBrainRail({ brain: d, focusKey: "gate" }, host, c.brainNodes(d));
    expect(doc.querySelector("#rpanel img")).toBeNull();
    expect(doc.querySelector("#rpanel .bpt")!.textContent).toContain("<img");
  });

  it("ESCAPES a hostile commit subject in the Learning rail", () => {
    const { doc, c } = loadConsole();
    const host = doc.querySelector("#rpanel")!;
    const d = { ...snapshot(), changes: [{ subject: XSS, author: "ada", at: Date.now(), sha: "deadbee", files: [] }] };
    c.renderBrainRail({ brain: d, focusKey: "learning" }, host, c.brainNodes(d));
    expect(doc.querySelector("#rpanel img")).toBeNull();
    expect(doc.querySelector("#rpanel .bds")!.textContent).toContain("<img");
  });

  it("ESCAPES a hostile node label when buildBrainSvg emits the SVG", () => {
    const { doc, c } = loadConsole();
    const nodes = c.brainNodes(snapshot());
    nodes[0].label = XSS;
    nodes[0].sub = XSS;
    const svg = c.buildBrainSvg(nodes, "");
    expect(svg).toContain("&lt;img"); // escaped in the emitted markup
    expect(svg).not.toContain("<img"); // never raw
    // And when parsed into the DOM it is text, not a live element.
    doc.querySelector("#rpanel")!.innerHTML = svg;
    expect(doc.querySelector("#rpanel img")).toBeNull();
    expect(doc.querySelector("#rpanel")!.textContent).toContain("<img"); // survives as text, not markup
  });

  it("ESCAPES a hostile repo-root name in the agent-health strip", () => {
    const { doc, c } = loadConsole();
    doc.querySelector("#rpanel")!.innerHTML = '<div id="agenthealth"></div>'; // strip's host isn't in index.html
    c.S.showAgentFiles = true;
    c.S.agentView = { summary: { skills: { total: 1, byRoot: { [XSS]: 1 } }, mcp: { total: 0 }, policyOk: true, claudeMdOk: true } };
    c.renderAgentHealth();
    expect(doc.querySelector("#agenthealth img")).toBeNull();
    expect(doc.querySelector("#agenthealth .aghealth")!.textContent).toContain("<img");
  });
});
