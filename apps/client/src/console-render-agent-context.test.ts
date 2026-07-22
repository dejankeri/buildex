// Browser test net for the operator console — the Agent Context viewer ("what my agent sees"). Loads
// the REAL bundle into jsdom (console-harness.ts) and asserts the two-pane renderer: the verdict, the
// grouped checklist, the authored-but-unlinked warning that makes the surface trustworthy, and — the
// property the whole net exists to hold — that operator/agent-supplied text (verb names, FILE
// CONTENTS) is ESCAPED not injected.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

const XSS = "<img src=x onerror=alert(1)>";

// The payload rBrain's sibling loader stashes on the tab: the derived view + live gateway + connectors.
function payload(over: Record<string, unknown> = {}) {
  const view = {
    summary: {
      skills: { total: 1, authored: 2, byRoot: { "team-acme": 1 }, fromPacks: 0 },
      mcp: { total: 1, fromPacks: 0, servers: ["buildex-pack:gmail"] },
      policyOk: true,
      claudeMdOk: true,
    },
    tree: [{
      name: "Agent (.claude)", type: "dir", path: ".claude", children: [
        { name: "CLAUDE.md", type: "file", path: "CLAUDE.md" },
        { name: ".mcp.json", type: "file", path: ".mcp.json" },
        {
          name: "skills (1)", type: "dir", path: ".claude/skills", children: [
            { name: "triage", type: "dir", path: "team-acme/skills/triage", note: "team-acme", children: [{ name: "SKILL.md", type: "file", path: "team-acme/skills/triage/SKILL.md" }] },
          ],
        },
        { name: "settings.json", type: "file", path: ".claude/settings.json" },
      ],
    }],
    discrepancies: [{ kind: "skill-unlinked", message: '"orphan" is written in team-acme but isn\'t linked — it won\'t be seen.', path: "team-acme/skills/orphan/SKILL.md" }],
    ...over,
  };
  return { view, gw: { status: [], tools: [{ name: "gmail__send", kind: "gated" }, { name: "secret__x", kind: "hidden" }] }, conn: [{ name: "gmail", connected: true }] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tabWith = (doc: any, actx: unknown) => ({ pane: doc.querySelector("#rpanel"), actx });

describe("console renderers (jsdom) — Agent Context viewer", () => {
  it("paints two panes, the five groups, and a WARN verdict when something isn't wired", () => {
    const { doc, c } = loadConsole();
    c.renderAgentContext(tabWith(doc, payload()));
    expect(doc.querySelector("#rpanel .actx-left")).not.toBeNull();
    expect(doc.querySelector("#rpanel .actx-right")).not.toBeNull();
    const groups = Array.from(doc.querySelectorAll("#rpanel .actx-gt") as any, (n: any) => n.textContent);
    expect(groups).toEqual(["Standing instructions", "Verbs", "Tools & connections", "Policy & gate", "Sources"]);
    const verdict = doc.querySelector("#rpanel .actx-verdict")!;
    expect(verdict.className).toContain("warn");
    expect(verdict.textContent).toContain("1 thing");
  });

  it("shows CLAUDE.md wired (✓), the linked verb, and the authored-but-unlinked verb as a ⚠ row", () => {
    const { doc, c } = loadConsole();
    c.renderAgentContext(tabWith(doc, payload()));
    // Standing instructions: CLAUDE.md present → an ok row
    const claude = Array.from(doc.querySelectorAll("#rpanel .actx-row") as any, (n: any) => n).find((r: any) => r.dataset.path === "CLAUDE.md");
    expect(claude.className).toContain("ok");
    // the linked verb is a clickable ok row
    const triage = Array.from(doc.querySelectorAll("#rpanel .actx-row") as any, (n: any) => n).find((r: any) => r.dataset.path === "team-acme/skills/triage/SKILL.md");
    expect(triage.className).toContain("ok");
    // the orphan verb is flagged and points at its unlinked SKILL.md
    const orphan = Array.from(doc.querySelectorAll("#rpanel .actx-row.warn") as any, (n: any) => n).find((r: any) => r.dataset.path === "team-acme/skills/orphan/SKILL.md");
    expect(orphan).not.toBeUndefined();
    expect(orphan.textContent).toContain("won’t see it");
  });

  it("gives an OK verdict when nothing is missing", () => {
    const { doc, c } = loadConsole();
    c.renderAgentContext(tabWith(doc, payload({ discrepancies: [] })));
    const verdict = doc.querySelector("#rpanel .actx-verdict")!;
    expect(verdict.className).toContain("ok");
    expect(verdict.textContent).toContain("Everything the agent needs is wired");
  });

  it("lists live tools and filters the hidden ones", () => {
    const { doc, c } = loadConsole();
    c.renderAgentContext(tabWith(doc, payload()));
    const tools = Array.from(doc.querySelectorAll("#rpanel .actx-tool code") as any, (n: any) => n.textContent);
    expect(tools).toContain("send"); // gmail__send → "send"
    expect(tools).not.toContain("x"); // the hidden tool is not shown
  });

  it("loads a file's contents into the right pane and ESCAPES them (config shown verbatim, inert)", async () => {
    const { doc, w, c } = loadConsole();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    w.fetch = (url: string) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ path: ".mcp.json", content: XSS }) });
    const tab = tabWith(doc, payload());
    c.renderAgentContext(tab);
    await c.actxSelectFile(tab, ".mcp.json");
    expect(doc.querySelector("#rpanel .actx-right img")).toBeNull(); // payload did NOT become a live element
    expect(doc.querySelector("#rpanel .actx-code")!.textContent).toContain("<img"); // shown as text
    expect(doc.querySelector("#rpanel .actx-rhead")!.textContent).toContain(".mcp.json");
  });

  it("ESCAPES a hostile verb note/name in the checklist", () => {
    const { doc, c } = loadConsole();
    const p = payload();
    // a hostile skill folder name coming off disk
    (p.view.tree[0]!.children![2] as any).children[0] = { name: XSS, type: "dir", path: "team-acme/skills/x", note: XSS, children: [{ name: "SKILL.md", type: "file", path: "team-acme/skills/x/SKILL.md" }] };
    c.renderAgentContext(tabWith(doc, p));
    expect(doc.querySelector("#rpanel img")).toBeNull();
    expect(doc.querySelector("#rpanel .actx-groups")!.textContent).toContain("<img");
  });
});
