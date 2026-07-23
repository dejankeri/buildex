// Browser test net for the operator console — the Loops panel. Like its siblings it loads the REAL
// bundle into jsdom (console-harness.ts) and asserts renderer DOM output. Two things are load-bearing
// here: that operator/agent-supplied text (a loop title, a prompt, the action a run was blocked on)
// is ESCAPED not injected, and that every derived string on the card comes from the daemon rather
// than being re-computed in the browser.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

const XSS = "<img src=x onerror=alert(1)>";
const HOUR = 3_600_000;

/** A loop row in the shape /api/loops returns. */
function loop(over: Record<string, unknown> = {}) {
  return {
    name: "weekly-review",
    title: "Weekly review",
    prompt: "Read last week's activity log and draft the Monday update",
    scheduleText: "every Monday at 9:00 AM",
    enabled: true,
    activeHere: true,
    nextRun: Date.now() + 3 * 24 * HOUR,
    ...over,
  };
}

/** Load the console with the panel host present and `S.loops` seeded, then paint the list. */
function withLoops(rows: Record<string, unknown>[]) {
  const handle = loadConsole();
  const { doc, c } = handle;
  const host = doc.createElement("div");
  host.id = "looplist";
  (doc.querySelector("#rpanel") as unknown as { append(n: unknown): void }).append(host);
  c.S.loops = rows;
  c.S.rightTab = "loops";
  c.renderLoopList();
  return handle;
}

describe("console renderers (jsdom) — the Loops panel", () => {
  it("paints one card per loop, with the daemon's schedule sentence verbatim", () => {
    const { doc } = withLoops([loop(), loop({ name: "sweep", title: "Inbox sweep", scheduleText: "every 2 hours" })]);
    const cards = doc.querySelectorAll("#looplist .loopcard");
    expect(cards).toHaveLength(2);
    expect((cards[0] as any).querySelector(".loopt").textContent).toBe("Weekly review");
    expect((cards[0] as any).querySelector(".loopsched").textContent).toBe("every Monday at 9:00 AM");
    expect((cards[1] as any).querySelector(".loopsched").textContent).toBe("every 2 hours");
  });

  it("shows the prompt for a prompt loop and names the verb for a verb loop", () => {
    const { doc } = withLoops([loop(), loop({ name: "triage", prompt: undefined, verb: "triage-inbox" })]);
    const bodies = Array.from(doc.querySelectorAll("#looplist .loopbody") as any, (n: any) => n.textContent);
    expect(bodies[0]).toBe("Read last week's activity log and draft the Monday update");
    expect(bodies[1]).toBe("Runs the triage-inbox verb");
  });

  it("ESCAPES an agent-supplied title, prompt and blocker rather than injecting them", () => {
    const { doc } = withLoops([loop({ title: XSS, prompt: XSS, status: "needs-approval", blockedOn: XSS })]);
    const card = doc.querySelector("#looplist .loopcard") as any;
    // Nothing was PARSED as markup: no element the payload asked for exists anywhere on the card.
    expect(card.querySelector("img, script, iframe")).toBeNull();
    // ...and every place the string appears, it appears as text, verbatim.
    expect(card.querySelector(".loopt").textContent).toBe(XSS);
    expect(card.querySelector(".loopbody").textContent).toBe(XSS);
    expect(card.querySelector(".loopblocked").textContent).toContain(XSS);
    // The one attribute that carries it is set as an attribute VALUE (setAttribute), never markup.
    expect(card.querySelector(".loopmore").getAttribute("aria-label")).toBe("More actions for " + XSS);
  });

  it("distinguishes the two switches - paused for everyone vs not running here", () => {
    // loops.yaml is shared, so "off" is ambiguous unless the card says WHICH switch is off.
    const everyone = withLoops([loop({ enabled: false })]).doc.querySelector("#looplist .loopcard") as any;
    expect(everyone.className).toContain("off");
    expect(everyone.querySelector(".loopnext").textContent).toBe("paused for everyone");

    const here = withLoops([loop({ activeHere: false })]).doc.querySelector("#looplist .loopcard") as any;
    expect(here.className).toContain("off");
    expect(here.querySelector(".loopnext").textContent).toBe("not running on this machine");
    expect(here.querySelector(".tgl").textContent).toBe("Run here");

    const live = withLoops([loop()]).doc.querySelector("#looplist .loopcard") as any;
    expect(live.className).not.toContain("off");
    expect(live.querySelector(".loopnext").textContent).toContain("next ");
    expect(live.querySelector(".tgl").textContent).toBe("Pause here");
  });

  it("puts the company-wide pause in the menu, so the card's own switch is unambiguously local", () => {
    const { doc } = withLoops([loop()]);
    const card = doc.querySelector("#looplist .loopcard") as any;
    (card.querySelector(".loopmore") as any).click();
    const items = Array.from(doc.querySelectorAll("[data-menu] button") as any, (n: any) => n.textContent);
    expect(items).toEqual(["✎Edit loop", "⌛Run history", "⏸Pause for everyone", "⌫Delete loop"]);
  });

  it("renders a status chip per outcome, and none at all before the first run", () => {
    const chip = (status?: string) => {
      const { doc } = withLoops([loop(status ? { status, lastRun: Date.now() - 60_000 } : {})]);
      const el = (doc.querySelector("#looplist .loopcard") as any).querySelector(".pill");
      return el && el.textContent;
    };
    expect(chip()).toBeNull();
    expect(chip("ok")).toContain("Ran");
    expect(chip("failed")).toBe("Failed");
    expect(chip("needs-approval")).toBe("Needed you");
    expect(chip("missed")).toBe("Missed");
    expect(chip("running")).toBe("Running");
  });

  it("spells out what a blocked run needed a human for", () => {
    const { doc } = withLoops([loop({ status: "needs-approval", blockedOn: "send an email to ops@acme.com" })]);
    expect((doc.querySelector("#looplist .loopblocked") as any).textContent).toBe(
      "It tried to send an email to ops@acme.com. Run it now to approve.",
    );
    // ...and the chip carries the state, so the card never says the same sentence twice.
    expect((doc.querySelector("#looplist .pill") as any).textContent).toBe("Needed you");
  });

  it("disables Run now while a run is in flight, so a second tap cannot double-fire it", () => {
    const { doc } = withLoops([loop({ status: "running" })]);
    const run = (doc.querySelector("#looplist .loopcard") as any).querySelector(".run");
    expect(run.textContent).toBe("Running…");
    expect(run.getAttribute("disabled")).not.toBeNull();
  });

  it("keeps Delete behind the ⋯, never one tap away from Run now", () => {
    const { doc } = withLoops([loop()]);
    const card = doc.querySelector("#looplist .loopcard") as any;
    const inline = Array.from(card.querySelectorAll(".ra button") as any, (n: any) => n.textContent);
    expect(inline).toEqual(["Run now", "Pause here", "⋯"]);

    (card.querySelector(".loopmore") as any).click();
    const items = Array.from(doc.querySelectorAll("[data-menu] button") as any, (n: any) => n.textContent);
    expect(items).toContain("⌫Delete loop");
  });

  it("offers suggestions, not an empty box, when nothing is scheduled", () => {
    const { doc } = withLoops([]);
    const empty = doc.querySelector("#looplist .loopempty") as any;
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain("Nothing scheduled yet");
    expect(empty.querySelectorAll(".loopsugs button").length).toBeGreaterThan(1);
  });

  it("badges the tab with the number of loops waiting on the operator", () => {
    const { doc, c } = loadConsole();
    c.S.loops = [loop({ status: "needs-approval" }), loop({ name: "b", status: "ok" })];
    c.renderLoopBadge();
    const badge = doc.querySelector("#lbadge") as any;
    expect(badge.textContent).toBe("1");
    expect(badge.style.display).toBe("");

    c.S.loops = [loop({ status: "ok" })];
    c.renderLoopBadge();
    expect(badge.style.display).toBe("none");
  });
});

describe("console renderers (jsdom) — the loop composer", () => {
  /** Load the console with the composer host present, then open the form. */
  function withComposer(seed?: Record<string, unknown>) {
    const handle = loadConsole();
    const { doc, c } = handle;
    const host = doc.createElement("div");
    host.id = "loopcomposer";
    (doc.querySelector("#rpanel") as unknown as { append(n: unknown): void }).append(host);
    c.openLoopComposer(seed);
    return handle;
  }

  it("opens on the time-of-day mode for a fresh loop, with the interval row hidden", () => {
    const { doc } = withComposer();
    const at = doc.querySelector("#loopcomposer .f-at") as any;
    expect(at).not.toBeNull();
    const rows = doc.querySelectorAll("#loopcomposer .looprow") as any;
    const everyRow = Array.from(rows as any, (n: any) => n).find((n: any) => n.querySelector(".f-every"));
    expect((everyRow as any).style.display).toBe("none");
  });

  it("pre-fills from a suggestion without creating anything", () => {
    const { doc } = withComposer({ title: "Inbox sweep", prompt: "Sweep it", every: "2h" });
    expect((doc.querySelector("#loopcomposer .f-title") as any).value).toBe("Inbox sweep");
    expect((doc.querySelector("#loopcomposer .f-prompt") as any).value).toBe("Sweep it");
    expect((doc.querySelector("#loopcomposer .f-every") as any).value).toBe("2h");
    expect((doc.querySelector("#loopcomposer .loopreview") as any).textContent).toBe("Runs every 2h");
    expect((doc.querySelector("#loopcomposer h5") as any).textContent).toBe("New loop");
  });

  it("echoes the schedule back in words as it is built", () => {
    const { doc } = withComposer();
    const preview = doc.querySelector("#loopcomposer .loopreview") as any;
    expect(preview.textContent).toBe("Runs every day at 09:00");

    const monday = Array.from(doc.querySelectorAll("#loopcomposer .daybtn") as any, (n: any) => n)[0] as any;
    monday.click();
    expect(preview.textContent).toBe("Runs every Monday at 09:00");
  });

  it("switches to the interval mode and previews that instead", () => {
    const { doc } = withComposer();
    // Select by attribute, not position: there are two segmented controls now (what it runs, how
    // often), so an index would silently target the wrong one.
    (doc.querySelector('#loopcomposer .seg[data-mode="every"]') as any).click();
    const preview = doc.querySelector("#loopcomposer .loopreview") as any;
    expect(preview.textContent).toBe("Choose how often it runs.");
  });

  it("refuses to submit without a name and something to do", async () => {
    const { doc } = withComposer();
    (doc.querySelector("#loopcomposer .save") as any).click();
    const msg = doc.querySelector("#loopcomposer .emsg") as any;
    expect(msg.textContent).toContain("needs a name");
    expect(msg.className).toContain("bad");
  });

  it("round-trips a real loop's schedule - the /api/loops shape, not the flat suggestion shape", () => {
    // Regression: the form read flat at/every/days, which only a SUGGESTION has. An /api/loops
    // record carries a structured `schedule`, so editing a real loop opened with an empty schedule
    // and saving 400'd.
    const { doc } = withComposer(loop({ schedule: { kind: "at", hour: 16, minute: 0, days: ["fri"] } }));
    expect((doc.querySelector("#loopcomposer .f-at") as any).value).toBe("16:00");
    const on = Array.from(doc.querySelectorAll("#loopcomposer .daybtn.on") as any, (n: any) => n.dataset.day);
    expect(on).toEqual(["fri"]);
    const mode = Array.from(doc.querySelectorAll("#loopcomposer .seg.on") as any, (n: any) => n.dataset.mode).filter(Boolean);
    expect(mode).toEqual(["at"]);
    expect((doc.querySelector("#loopcomposer .loopreview") as any).textContent).toBe("Runs every Friday at 16:00");
  });

  it("round-trips an interval loop the same way", () => {
    const { doc } = withComposer(loop({ schedule: { kind: "every", ms: 7_200_000, raw: "2h" } }));
    expect((doc.querySelector("#loopcomposer .f-every") as any).value).toBe("2h");
    const mode = Array.from(doc.querySelectorAll("#loopcomposer .seg.on") as any, (n: any) => n.dataset.mode).filter(Boolean);
    expect(mode).toEqual(["every"]);
  });

  it("opens a verb loop on the verb side instead of pretending it has no body", () => {
    const { doc } = withComposer(loop({ prompt: undefined, verb: "pipeline-digest", schedule: { kind: "every", ms: 7_200_000, raw: "2h" } }));
    const body = Array.from(doc.querySelectorAll("#loopcomposer .seg.on") as any, (n: any) => n.dataset.body).filter(Boolean);
    expect(body).toEqual(["verb"]);
    const promptRow = (doc.querySelector("#loopcomposer .f-prompt") as any).closest(".looprow");
    expect(promptRow.style.display).toBe("none");
    expect((doc.querySelector("#loopcomposer .f-verb") as any)).not.toBeNull();
  });

  it("defaults a fresh loop to a prompt, with the verb picker out of the way", () => {
    const { doc } = withComposer();
    const body = Array.from(doc.querySelectorAll("#loopcomposer .seg.on") as any, (n: any) => n.dataset.body).filter(Boolean);
    expect(body).toEqual(["prompt"]);
    const verbRow = (doc.querySelector("#loopcomposer .f-verb") as any).closest(".looprow");
    expect(verbRow.style.display).toBe("none");
  });

  it("titles itself Edit when opened on an existing loop", () => {
    const { doc } = withComposer(loop());
    expect((doc.querySelector("#loopcomposer h5") as any).textContent).toBe("Edit loop");
    expect((doc.querySelector("#loopcomposer .f-title") as any).value).toBe("Weekly review");
    expect((doc.querySelector("#loopcomposer .save") as any).textContent).toBe("Save");
  });
});

// The history strip, the spend line, and the two dialogs behind them. What is pinned here is that
// the panel never re-derives the daemon's numbers, and that the strip stays a timeline (oldest
// first) rather than the last-run chip it replaced.
function run(over: Record<string, unknown> = {}) {
  return { at: Date.now() - HOUR, status: "ok", sessionId: "s1", ...over };
}

describe("console renderers (jsdom) — a loop's run history", () => {
  it("paints one mark per run, oldest first, so a pattern is visible at a glance", () => {
    const { doc } = withLoops([
      loop({ runs: [run({ at: 3, status: "failed" }), run({ at: 2, status: "ok" }), run({ at: 1, status: "needs-approval" })] }),
    ]);
    const marks = Array.from(doc.querySelectorAll("#looplist .loopstrip .lrun") as any, (n: any) => n.className);
    expect(marks).toEqual(["lrun warn", "lrun ok", "lrun bad"]);
  });

  it("shows no strip at all for a loop that has never run", () => {
    const { doc } = withLoops([loop({ runs: [] })]);
    expect(doc.querySelector("#looplist .loopstrip")).toBeNull();
  });

  it("puts what a run cost on the last-run chip, and omits it when the agent did not price it", () => {
    const priced = withLoops([loop({ status: "ok", lastRun: Date.now() - HOUR, runs: [run({ costUsd: 0.0412 })] })]);
    expect(priced.doc.querySelector("#looplist .pill")!.textContent).toContain("$0.04");

    const unpriced = withLoops([loop({ status: "ok", lastRun: Date.now() - HOUR, runs: [run()] })]);
    expect(unpriced.doc.querySelector("#looplist .pill")!.textContent).not.toContain("$");
  });

  it("says 'under $0.01' rather than rounding real spending down to nothing", () => {
    const { c } = loadConsole();
    expect(c.usd(0.0004)).toBe("under $0.01");
    expect(c.usd(0)).toBe("$0.00");
    expect(c.usd(1.239)).toBe("$1.24");
  });

  it("describes a run in one sentence, carrying what a blocked one wanted", () => {
    const { c } = loadConsole();
    expect(c.runSentence({ at: Date.now(), status: "needs-approval", blockedOn: "send an email to ops@acme.com" })).toContain(
      "wanted to send an email to ops@acme.com",
    );
    expect(c.runSentence({ at: Date.now(), status: "missed" })).toContain("Missed");
  });

  it("drops the relative time for a history row, which already carries the exact time beside it", () => {
    const { c } = loadConsole();
    const r = { at: Date.now() - HOUR, status: "ok", costUsd: 0.17 };
    expect(c.runSentence(r)).toBe("Ran 1h · about $0.17");
    expect(c.runSentence(r, { absolute: true })).toBe("Ran · about $0.17");
  });

  it("keeps what a blocked run wanted in the history row - it is the point of the row", () => {
    const { doc, c } = loadConsole();
    c.openLoopHistory(loop({ runs: [run({ status: "needs-approval", costUsd: 0.24, blockedOn: "send an email to team@acme.com" })] }));
    expect((doc.querySelector(".loophist .lh-what") as any).textContent).toBe(
      "Needed you · about $0.24 · wanted to send an email to team@acme.com",
    );
  });

  it("lists every remembered run in the history dialog, ESCAPING what the agent wrote", () => {
    const { doc, c } = loadConsole();
    c.openLoopHistory(loop({ title: XSS, runs: [run({ status: "needs-approval", blockedOn: XSS }), run()] }));
    const card = doc.querySelector(".loophist") as any;
    expect(card.querySelector("img, script, iframe")).toBeNull();
    expect(card.querySelectorAll(".lh-row")).toHaveLength(2);
    expect(card.querySelector(".ovh").textContent).toBe(XSS);
  });

  it("says so plainly when a loop has never run here", () => {
    const { doc, c } = loadConsole();
    c.openLoopHistory(loop({ runs: [] }));
    expect((doc.querySelector(".loophist .ovp") as any).textContent).toContain("not run on this machine yet");
  });
});

describe("console renderers (jsdom) — the daily spending limit", () => {
  /** Load the console with the spend host present and `S.loopSpend` seeded, then paint it. */
  function withSpend(spend: unknown) {
    const handle = loadConsole();
    const host = handle.doc.createElement("div");
    host.id = "loopspend";
    (handle.doc.querySelector("#rpanel") as unknown as { append(n: unknown): void }).append(host);
    handle.c.S.loopSpend = spend;
    handle.c.renderLoopSpend();
    return handle;
  }

  it("says nothing before anything has run - an empty panel needs no spend line", () => {
    const { doc } = withSpend({ today: { runs: 0, costUsd: 0 }, month: { runs: 0, costUsd: 0 }, overCap: false });
    expect(doc.querySelector("#loopspend .loopcap")).toBeNull();
  });

  it("shows today and the month when there is no ceiling, and offers to set one", () => {
    const { doc } = withSpend({ today: { runs: 4, costUsd: 0.42 }, month: { runs: 90, costUsd: 6.1 }, overCap: false });
    expect((doc.querySelector("#loopspend .lc-tx") as any).textContent).toBe("About $0.42 today · $6.10 this month");
    expect((doc.querySelector("#loopspend .lc-edit") as any).textContent).toBe("Set a limit");
  });

  it("shows today against the ceiling once one is set", () => {
    const { doc } = withSpend({ today: { runs: 4, costUsd: 0.42 }, month: { runs: 90, costUsd: 6.1 }, capUsd: 5, overCap: false });
    expect((doc.querySelector("#loopspend .lc-tx") as any).textContent).toBe("About $0.42 of $5.00 today");
  });

  it("says the scheduler is holding off - and when it resumes - rather than looking broken", () => {
    const { doc } = withSpend({ today: { runs: 40, costUsd: 5.2 }, month: { runs: 90, costUsd: 6.1 }, capUsd: 5, overCap: true });
    const line = doc.querySelector("#loopspend .loopcap.over") as any;
    expect(line.textContent).toContain("spent its $5.00 for today");
    expect(line.textContent).toContain("after midnight");
    expect(line.querySelector(".lc-edit").textContent).toBe("Change limit");
  });

  it("opens the limit editor pre-filled, and blank when there is no limit", () => {
    const { doc, c } = loadConsole();
    c.S.loopSpend = { today: { costUsd: 0.4 }, month: { costUsd: 2 }, capUsd: 5, overCap: false };
    c.openLoopBudget();
    expect((doc.querySelector(".loopbudget .lb-cap") as any).value).toBe("5");
    (doc.querySelector(".ovbackdrop") as any).remove();

    c.S.loopSpend = { today: { costUsd: 0.4 }, month: { costUsd: 2 }, overCap: false };
    c.openLoopBudget();
    expect((doc.querySelector(".loopbudget .lb-cap") as any).value).toBe("");
  });

  it("tells the operator running a loop by hand is never blocked - the limit is about UNattended work", () => {
    const { doc, c } = loadConsole();
    c.S.loopSpend = { today: { costUsd: 0 }, month: { costUsd: 0 }, overCap: false };
    c.openLoopBudget();
    expect((doc.querySelector(".loopbudget .ovp") as any).textContent).toContain("never blocked");
  });
});
