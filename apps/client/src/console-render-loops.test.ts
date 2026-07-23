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

  it("says a paused loop is paused instead of counting down to a run that will not happen", () => {
    const { doc } = withLoops([loop({ enabled: false })]);
    const card = doc.querySelector("#looplist .loopcard") as any;
    expect(card.className).toContain("off");
    expect(card.querySelector(".loopnext").textContent).toBe("paused");
    expect(card.querySelector(".tgl").textContent).toBe("Resume");
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
    expect(inline).toEqual(["Run now", "Pause", "⋯"]);

    (card.querySelector(".loopmore") as any).click();
    const items = Array.from(doc.querySelectorAll("[data-menu] button") as any, (n: any) => n.textContent);
    expect(items).toEqual(["✎Edit loop", "⌫Delete loop"]);
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
    const segs = Array.from(doc.querySelectorAll("#loopcomposer .seg") as any, (n: any) => n) as any[];
    segs[0].click(); // "Every…"
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

  it("titles itself Edit when opened on an existing loop", () => {
    const { doc } = withComposer(loop());
    expect((doc.querySelector("#loopcomposer h5") as any).textContent).toBe("Edit loop");
    expect((doc.querySelector("#loopcomposer .f-title") as any).value).toBe("Weekly review");
    expect((doc.querySelector("#loopcomposer .save") as any).textContent).toBe("Save");
  });
});
