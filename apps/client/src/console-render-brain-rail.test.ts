// Browser test net for the operator console — the Brain RAIL (the right-panel map) + the Documents
// zones + the media guard. Like its siblings it loads the REAL bundle into jsdom (console-harness.ts)
// and asserts renderer DOM output — above all that operator/agent-supplied text (verb names, pending
// tool names, commit subjects) is ESCAPED not injected, and that the Company/Private scope lens
// filters verbs by ownership without faking the company-wide stages.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

const XSS = "<img src=x onerror=alert(1)>";

// A brain snapshot with owned verbs (one team, one private) so the scope lens has something real to
// filter. Mirrors the shape rBrain() stashes on `S.brain`.
function snap() {
  return {
    conn: [{ name: "gmail", connected: true }, { name: "calendar", connected: false }],
    gw: {
      status: [{ name: "gateway", connected: true }],
      tools: [{ name: "gmail__send", kind: "gated" }, { name: "fs__read", kind: "read" }, { name: "secret__x", kind: "hidden" }],
    },
    pend: [{ tool: { name: "SendEmail", input: { to: "board@acme.co" } } }],
    skills: [
      { name: "triage", description: "sort the inbox", root: "team-acme" },
      { name: "my-journal", description: "private notes", root: "private-you" },
    ],
    rules: [
      { name: "Operating rules", description: "how we run", root: "team-acme", path: "team-acme/CLAUDE.md" },
      { name: "My rules", description: "just for me", root: "private-you", path: "private-you/CLAUDE.md" },
    ],
    changes: [{ subject: "init brain", author: "ada", at: Date.now() - 1000, sha: "abcdef1234567", files: ["x.md"] }],
    cfg: { company: { name: "Acme" } },
  };
}

describe("console renderers (jsdom) — Brain rail (right panel)", () => {
  it("paints the mini live star, the scope lens, and one accordion section per loop stage", () => {
    const { doc, c } = loadConsole();
    c.S.brain = snap();
    c.renderBrainPanel();
    expect(doc.querySelector("#rpanel .brailstar .bsvg")).not.toBeNull(); // the mini star
    expect(doc.querySelectorAll("#rpanel .bscope .bseg")).toHaveLength(3); // All · Company · Private
    expect(doc.querySelectorAll("#rpanel .bsecs .bsec")).toHaveLength(5); // the five loop stages
    const labels = Array.from(doc.querySelectorAll("#rpanel .bsec-t") as any, (n: any) => n.textContent);
    expect(labels).toEqual(["Sensors", "Rules & Skills", "Tools", "Gate", "Learning"]);
  });

  it("the Gate auto-opens while something is waiting; the other stages start closed", () => {
    const { doc, c } = loadConsole();
    c.S.brain = snap();
    c.renderBrainPanel();
    const secs = Array.from(doc.querySelectorAll("#rpanel .bsec") as any, (n: any) => n);
    expect(secs[3].className).toContain("gate");
    expect(secs[3].className).not.toContain("closed"); // Gate open — it has a pending card
    expect(secs[1].className).toContain("closed"); // Rules & Skills closed by default
  });

  it("a section header toggles its stage open/closed and remembers it", () => {
    const { doc, c } = loadConsole();
    c.S.brain = snap();
    c.renderBrainPanel();
    const policy = Array.from(doc.querySelectorAll("#rpanel .bsec") as any, (n: any) => n)[1];
    expect(policy.className).toContain("closed");
    (policy.querySelector(".bsec-h") as any).onclick();
    expect(policy.className).not.toContain("closed");
    expect(c.S.brainOpen["policy"]).toBe(true);
  });

  it("Rules & Skills lists rules then skills under group headers, and offers a Teach affordance", () => {
    const { doc, c } = loadConsole();
    c.S.brain = snap();
    c.renderBrainPanel();
    const bodies = Array.from(doc.querySelectorAll("#rpanel .bsec-b") as any, (n: any) => n);
    const policyBody = bodies[1];
    expect(Array.from(policyBody.querySelectorAll(".bsub") as any, (n: any) => n.textContent))
      .toEqual(["Always-on rules", "Skills"]);
    // rules render first (§), then skills (✦) — one flat rcard list under the two group labels
    expect(Array.from(policyBody.querySelectorAll(".rcard .cn") as any, (n: any) => n.textContent))
      .toEqual(["§ Operating rules", "§ My rules", "✦ triage", "✦ my-journal"]);
    expect(policyBody.querySelector(".bsec-add")!.textContent).toContain("Teach");
  });

  it("the Gate lists pending cards with Approve/Deny", () => {
    const { doc, c } = loadConsole();
    c.S.brain = snap();
    c.renderBrainPanel();
    const gateBody = Array.from(doc.querySelectorAll("#rpanel .bsec-b") as any, (n: any) => n)[3];
    expect(gateBody.querySelector(".bpend .bpt")!.textContent).toBe("SendEmail");
    expect(gateBody.querySelector(".bpend .approve")).not.toBeNull();
    expect(gateBody.querySelector(".bpend .dny")).not.toBeNull();
  });

  it("a Gate card reads as a SENTENCE (humanizeCard), with the raw request folded away", () => {
    const { doc, c } = loadConsole();
    c.S.brain = {
      ...snap(),
      // A connector action carries its own summary — the gate must show that, never the JSON.
      pend: [{ tool: { name: "gmail.send", input: { connector: "gmail", tool: "send", args: { to: "dana@globex.com" }, summary: "Send email to dana@globex.com - reply on SSO." } } }],
    };
    c.renderBrainPanel();
    const card = doc.querySelector("#rpanel .bpend")!;
    expect(card.querySelector(".bpw")!.textContent).toBe("Send email to dana@globex.com - reply on SSO.");
    expect(card.querySelector(".bpw")!.textContent).not.toContain("{"); // no JSON in the body
    // the raw request is still one disclosure away, collapsed
    const details = card.querySelector("details.bpr") as any;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Show request");
    expect(details.querySelector("pre")!.textContent).toContain('"connector": "gmail"');
  });

  it("ESCAPES a hostile summary in a Gate card body", () => {
    const { doc, c } = loadConsole();
    c.S.brain = { ...snap(), pend: [{ tool: { name: "send", input: { summary: XSS } } }] };
    c.renderBrainPanel();
    expect(doc.querySelector("#rpanel .bpend .bpw")!.textContent).toContain("<img");
    expect(doc.querySelector("#rpanel .bpend img")).toBeNull();
  });

  it("the Company/Private lens filters BOTH rules and skills by ownership — never hides company-wide stages", () => {
    const { doc, c } = loadConsole();
    c.S.brain = snap();

    c.setBrainScope("team"); // Company
    let bodies = Array.from(doc.querySelectorAll("#rpanel .bsec-b") as any, (n: any) => n);
    expect(Array.from(bodies[1].querySelectorAll(".rcard .cn") as any, (n: any) => n.textContent)).toEqual(["§ Operating rules", "✦ triage"]);
    // company-wide stages (sensor/tools/gate/learning) are marked "shared", not emptied
    expect(doc.querySelectorAll("#rpanel .bsec-tag")).toHaveLength(4);
    expect(doc.querySelector("#rpanel .bsec .bsec-tag")!.textContent).toContain("shared");

    c.setBrainScope("private"); // mine
    bodies = Array.from(doc.querySelectorAll("#rpanel .bsec-b") as any, (n: any) => n);
    expect(Array.from(bodies[1].querySelectorAll(".rcard .cn") as any, (n: any) => n.textContent)).toEqual(["§ My rules", "✦ my-journal"]);

    c.setBrainScope("all");
    bodies = Array.from(doc.querySelectorAll("#rpanel .bsec-b") as any, (n: any) => n);
    expect(bodies[1].querySelectorAll(".rcard").length).toBe(4); // 2 rules + 2 skills
    expect(doc.querySelectorAll("#rpanel .bsec-tag")).toHaveLength(0); // no "shared" tags under All
  });

  it("an empty Private view names the gap in both groups instead of reading as broken", () => {
    const { doc, c } = loadConsole();
    // only company-owned rules/skills ⇒ the Private lens has nothing of its own to show
    c.S.brain = {
      ...snap(),
      skills: [{ name: "triage", description: "x", root: "team-acme" }],
      rules: [{ name: "Operating rules", description: "x", root: "team-acme", path: "team-acme/CLAUDE.md" }],
    };
    c.setBrainScope("private");
    const policyBody = Array.from(doc.querySelectorAll("#rpanel .bsec-b") as any, (n: any) => n)[1];
    const empties = Array.from(policyBody.querySelectorAll(".bempty") as any, (n: any) => n.textContent);
    expect(empties.some((t: string) => /No private rules/.test(t))).toBe(true);
    expect(empties.some((t: string) => /No private skills/.test(t))).toBe(true);
  });

  it("ESCAPES a hostile skill name in Rules & Skills — inert text, never a live element", () => {
    const { doc, c } = loadConsole();
    c.S.brain = { ...snap(), rules: [], skills: [{ name: XSS, description: "x", root: "team-acme" }] };
    c.renderBrainPanel();
    expect(doc.querySelector("#rpanel img")).toBeNull();
    expect(doc.querySelector("#rpanel .rcard .cn")!.textContent).toContain("<img");
  });

  it("ESCAPES a hostile rule name in Rules & Skills", () => {
    const { doc, c } = loadConsole();
    c.S.brain = { ...snap(), rules: [{ name: XSS, description: "x", root: "team-acme", path: "team-acme/CLAUDE.md" }], skills: [] };
    c.renderBrainPanel();
    expect(doc.querySelector("#rpanel img")).toBeNull();
    expect(doc.querySelector("#rpanel .rcard .cn")!.textContent).toContain("<img");
  });

  it("ESCAPES a hostile pending tool name in the Gate", () => {
    const { doc, c } = loadConsole();
    c.S.brain = { ...snap(), pend: [{ tool: { name: XSS, input: {} } }] };
    c.renderBrainPanel();
    expect(doc.querySelector("#rpanel img")).toBeNull();
    expect(doc.querySelector("#rpanel .bpend .bpt")!.textContent).toContain("<img");
  });
});

describe("console renderers (jsdom) — Documents zones + the media guard", () => {
  it("renders two zones and an honest empty Connected state with a connect affordance", () => {
    const { doc, c } = loadConsole();
    c.S.tree = [];
    c.rDocs();
    expect(doc.querySelector("#rpanel .rhead h4")!.textContent).toBe("Documents");
    const zones = Array.from(doc.querySelectorAll("#rpanel .dzone-t") as any, (n: any) => n.textContent);
    expect(zones).toEqual(["In your repo", "Connected"]);
    expect(doc.querySelector("#rpanel .dext-empty")!.textContent).toContain("No drives connected");
    expect(doc.querySelector("#rpanel .dext-add")!.textContent).toContain("Connect a drive");
  });

  it("still splits the synced repo into Company/Private inside the 'In your repo' zone", () => {
    const { doc, c } = loadConsole();
    c.S.tree = [
      { type: "dir", name: "team-acme", path: "team-acme", children: [{ type: "file", name: "runway.md", path: "team-acme/runway.md" }] },
      { type: "dir", name: "private-you", path: "private-you", children: [{ type: "file", name: "notes.md", path: "private-you/notes.md" }] },
    ];
    c.rDocs();
    const sections = Array.from(doc.querySelectorAll("#tree .tsec .tsec-t") as any, (n: any) => n.textContent);
    expect(sections).toEqual(["Company", "Private"]);
  });

  it("classifyDrop keeps light files in the repo and routes media/heavy files out of git", () => {
    const { c } = loadConsole();
    c.S.extStore = null; // no drive connected
    expect(c.classifyDrop({ name: "notes.md", size: 2000 })).toBe("repo");
    expect(c.classifyDrop({ name: "data.csv", size: 100 * 1024 })).toBe("repo");
    // extension-less and dotfile light text belongs in the repo, not declined to a drive
    expect(c.classifyDrop({ name: "LICENSE", size: 10 })).toBe("repo");
    expect(c.classifyDrop({ name: "Dockerfile", size: 400 })).toBe("repo");
    expect(c.classifyDrop({ name: ".gitignore", size: 80 })).toBe("repo");
    expect(c.classifyDrop({ name: ".env", size: 120 })).toBe("repo");
    expect(c.classifyDrop({ name: "big.md", size: 2 * 1024 * 1024 })).toBe("held"); // over the light cap
    expect(c.classifyDrop({ name: "clip.mp4", size: 1000 })).toBe("held"); // media type, no drive
    expect(c.classifyDrop({ name: "noext-but-huge", size: 5 * 1024 * 1024 })).toBe("held"); // no ext but over cap → not light
  });

  it("classifyDrop routes media to a connected drive when one exists", () => {
    const { c } = loadConsole();
    c.S.extStore = { drives: [{ name: "Team Drive", provider: "google" }] };
    expect(c.classifyDrop({ name: "clip.mp4", size: 50 * 1024 * 1024 })).toBe("external");
    expect(c.classifyDrop({ name: "notes.md", size: 1000 })).toBe("repo"); // light still syncs
  });
});
