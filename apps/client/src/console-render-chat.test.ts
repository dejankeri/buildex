// Browser test net for the chat surface — the turn renderer, the incremental markdown mount, the
// code-block chrome, the follow-the-stream scroller, and the composer's completion/recall wiring.
// This is where the "polished chat" behaviours are pinned: they are all DOM behaviours, so they can
// only be asserted against the REAL bundle in jsdom (see console-harness.ts).
//
// The load-bearing assertion in here is the streaming one: mdInto() must leave already-rendered
// blocks ALONE as tokens arrive. That is not cosmetic — re-setting one innerHTML per token is what
// used to destroy the operator's text selection mid-answer.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConsole } from "./console-harness.js";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

/** A chat tab backed by a real thread node, as buildChatPane would leave it. */
function chatTab(c: Record<string, any>, doc: any) {
  const pane = doc.createElement("div");
  const thread = doc.createElement("div");
  thread.className = "thread";
  pane.appendChild(thread);
  doc.body.appendChild(pane);
  return { id: "t1", type: "chat", title: "New chat", sessionId: "s1", pane, thread, sent: [] as string[] };
}

describe("chat — incremental markdown mount (mdInto)", () => {
  it("reuses the DOM of every block that has not changed", () => {
    const { doc, c } = loadConsole();
    const node = doc.createElement("div");
    c.mdInto(node, "# Title\n\nfirst para\n\nsecond par");
    const [h1, p1] = [node.children[0], node.children[1]];
    c.mdInto(node, "# Title\n\nfirst para\n\nsecond paragraph");
    // Same node objects — untouched, so any selection inside them survives the token.
    expect(node.children[0]).toBe(h1);
    expect(node.children[1]).toBe(p1);
    expect(node.children[2]!.textContent).toBe("second paragraph");
    expect(node.children).toHaveLength(3);
  });

  it("drops trailing blocks when the source shrinks (a re-render, not an append)", () => {
    const { doc, c } = loadConsole();
    const node = doc.createElement("div");
    c.mdInto(node, "a\n\nb\n\nc");
    expect(node.children).toHaveLength(3);
    c.mdInto(node, "a");
    expect(node.children).toHaveLength(1);
    expect(node.textContent).toBe("a");
  });

  it("ESCAPES an agent answer that contains markup — the payload is inert text", () => {
    const { doc, c } = loadConsole();
    const node = doc.createElement("div");
    c.mdInto(node, 'look <img src=x onerror=alert(1)> and <script>alert(2)</script>');
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("script")).toBeNull();
    expect(node.textContent).toContain("<img");
  });

  it("stays inert for EVERY prefix of a hostile answer as it streams", () => {
    const { doc, c } = loadConsole();
    const node = doc.createElement("div");
    const hostile = "# <img src=x onerror=alert(1)>\n\n- <script>alert(2)</script>";
    for (let n = 1; n <= hostile.length; n++) {
      c.mdInto(node, hostile.slice(0, n));
      expect(node.querySelector("img"), hostile.slice(0, n)).toBeNull();
      expect(node.querySelector("script")).toBeNull();
    }
  });
});

describe("chat — code block chrome", () => {
  it("wraps a fenced block with a language label and a Copy button", () => {
    const { doc, c } = loadConsole();
    const node = doc.createElement("div");
    c.mdInto(node, "```js\nconst n = 7;\n```");
    const wrap = node.querySelector(".codewrap")!;
    expect(wrap).not.toBeNull();
    expect(wrap.querySelector(".cb-lang")!.textContent).toBe("js");
    expect(wrap.querySelector(".cb-copy")).not.toBeNull();
    expect(wrap.querySelector("pre.cb code")!.textContent).toBe("const n = 7;");
  });

  it("labels an un-tagged fence 'text' and never wraps the same block twice", () => {
    const { doc, c } = loadConsole();
    const node = doc.createElement("div");
    c.mdInto(node, "```\nplain\n```");
    expect(node.querySelector(".cb-lang")!.textContent).toBe("text");
    const pre = node.querySelector("pre.cb")!;
    c.enhanceCode(node);
    c.enhanceCode(node);
    expect(node.querySelectorAll(".codewrap")).toHaveLength(1);
    expect(pre.dataset.wrapped).toBe("1");
  });

  it("marks a still-streaming fence open so it reads as arriving, not as broken syntax", () => {
    const { doc, c } = loadConsole();
    const node = doc.createElement("div");
    c.mdInto(node, "```js\nconst n = 7;");
    expect(node.querySelector("pre.cb-open")).not.toBeNull();
    c.mdInto(node, "```js\nconst n = 7;\n```");
    expect(node.querySelector("pre.cb-open")).toBeNull();
  });
});

// The renderer net runs WITHOUT vendor/ loaded (see console-harness.ts), which is the guard's real
// test: these assert the monochrome path is correct, then load the actual vendored library to prove
// the coloured path works too.
describe("chat — syntax highlighting (vendored, optional)", () => {
  it("renders a code block correctly with the library absent", () => {
    const { doc, c } = loadConsole();
    const node = doc.createElement("div");
    c.mdInto(node, "```js\nconst n = 7;\n```");
    expect(node.querySelector("pre.cb code")!.textContent).toBe("const n = 7;");
    expect(node.querySelector(".hljs")).toBeNull(); // no library → no colour, and no crash
  });

  it("colours a closed block once the library IS present", () => {
    const { doc, w, c } = loadConsole();
    w.eval(readFileSync(join(WEB, "vendor", "highlight.min.js"), "utf8"));
    const node = doc.createElement("div");
    c.mdInto(node, "```js\nconst n = 7;\n```");
    const code = node.querySelector("pre.cb code")!;
    expect(code.className).toContain("hljs");
    expect(code.querySelectorAll(".hljs-keyword").length).toBeGreaterThan(0);
    expect(code.textContent).toBe("const n = 7;"); // colour is presentation — the source is unchanged
  });

  it("leaves a still-streaming block uncoloured until its fence closes", () => {
    const { doc, w, c } = loadConsole();
    w.eval(readFileSync(join(WEB, "vendor", "highlight.min.js"), "utf8"));
    const node = doc.createElement("div");
    c.mdInto(node, "```js\nconst n = 7;");
    expect(node.querySelector("pre.cb-open code")!.className).not.toContain("hljs");
    c.mdInto(node, "```js\nconst n = 7;\n```");
    expect(node.querySelector("pre.cb code")!.className).toContain("hljs");
  });

  it("does not let a hostile code block become live markup once highlighted", () => {
    const { doc, w, c } = loadConsole();
    w.eval(readFileSync(join(WEB, "vendor", "highlight.min.js"), "utf8"));
    const node = doc.createElement("div");
    c.mdInto(node, "```html\n<img src=x onerror=alert(1)>\n```");
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("pre.cb code")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("chat — turn rendering", () => {
  it("renders the operator's message as escaped text with its own actions", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    c.userTurn(tab, "<b>hi</b>", { onEdit: () => {} });
    const turn = tab.thread.querySelector(".turn.user")!;
    expect(turn.querySelector("b")).toBeNull();
    expect(turn.querySelector(".bubble.op")!.textContent).toBe("<b>hi</b>");
    expect([...turn.querySelectorAll(".ma")].map((b: any) => b.textContent)).toEqual(["Copy", "Edit"]);
  });

  it("shows a live turn's trace immediately, so Send never lands on an empty thread", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    const turn = c.agentTurn(tab, {});
    expect(tab.thread.querySelector(".turn.agent .work")!.style.display).not.toBe("none");
    turn.done();
  });

  it("keeps a replayed turn's trace hidden until it actually has steps", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    const turn = c.agentTurn(tab, { live: false });
    expect(tab.thread.querySelector(".work")!.style.display).toBe("none");
    turn.tool({ id: "1", name: "Read", path: "docs/x.md" });
    expect(tab.thread.querySelector(".work")!.style.display).not.toBe("none");
    turn.done();
  });

  it("folds narration emitted before a tool into the trace, keeping only the final run as the answer", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    const turn = c.agentTurn(tab, { live: false });
    turn.addText("Let me look that up.");
    turn.tool({ id: "1", name: "Read", path: "a.md" });
    turn.addText("The answer is 42.");
    turn.done();
    expect(tab.thread.querySelector(".wk-note")!.textContent).toBe("Let me look that up.");
    expect(tab.thread.querySelector(".md")!.textContent).toBe("The answer is 42.");
  });

  it("badges the model and marks a tool result", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    const turn = c.agentTurn(tab, { live: false, model: "opus" });
    turn.tool({ id: "t7", name: "Bash" });
    turn.toolDone({ id: "t7", ok: false });
    expect(tab.thread.querySelector(".mbadge")!.textContent).toBe("opus");
    expect(tab.thread.querySelector(".st2")!.textContent).toBe("✕");
    turn.done();
  });

  it("renders an error as an affordance with a Retry, not as prose in the answer", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    let retried = 0;
    const turn = c.agentTurn(tab, { live: false });
    turn.fail("the agent exploded", () => retried++);
    const err = tab.thread.querySelector(".turn-error")!;
    expect(err.querySelector(".te-msg")!.textContent).toBe("the agent exploded");
    (err.querySelector(".ma") as any).click();
    expect(retried).toBe(1);
    turn.done();
  });

  it("offers Copy on a finished answer but not on an empty one", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    const a = c.agentTurn(tab, { live: false });
    a.addText("done");
    a.done();
    expect(a.node.querySelector(".msg-actions .ma")!.textContent).toBe("Copy");
    const b = c.agentTurn(tab, { live: false });
    b.done();
    expect(b.node.querySelector(".msg-actions .ma")).toBeNull();
  });
});

describe("chat — history replay", () => {
  it("uses the recorded role to tell the operator's message from the agent's", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    c.renderHistory(tab, [
      { kind: "text", text: "what is our runway?", role: "user" },
      { kind: "text", text: "About 14 months." },
      { kind: "done" },
    ]);
    expect(tab.thread.querySelectorAll(".turn.user")).toHaveLength(1);
    expect(tab.thread.querySelector(".turn.user .bubble")!.textContent).toBe("what is our runway?");
    expect(tab.thread.querySelector(".turn.agent .md")!.textContent).toBe("About 14 months.");
  });

  it("falls back to the after-done heuristic for transcripts written before roles existed", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    c.renderHistory(tab, [
      { kind: "text", text: "old question" },
      { kind: "text", text: "old answer" },
      { kind: "done" },
      { kind: "text", text: "second question" },
    ]);
    expect([...tab.thread.querySelectorAll(".turn.user .bubble")].map((b: any) => b.textContent)).toEqual([
      "old question",
      "second question",
    ]);
  });

  it("does NOT mistake a mid-turn agent message for the operator when the role says otherwise", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    // A turn that never got its `done` (the old heuristic's failure case): the next text is the
    // AGENT still talking, and the recorded role says so.
    c.renderHistory(tab, [
      { kind: "text", text: "q", role: "user" },
      { kind: "tool", id: "1", name: "Read" },
      { kind: "text", text: "still me" },
    ]);
    expect(tab.thread.querySelectorAll(".turn.user")).toHaveLength(1);
  });
});

describe("chat — follow the stream", () => {
  /** jsdom does no layout, so scrollHeight/clientHeight are getter-only zeros. Give the element a
   *  fake geometry (scrollTop stays a real, writable property, which is what we assert on). */
  function geometry(node: any, scrollHeight: number, clientHeight: number, scrollTop: number) {
    Object.defineProperty(node, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(node, "clientHeight", { value: clientHeight, configurable: true });
    node.scrollTop = scrollTop;
  }

  it("keeps the thread pinned to the bottom while the operator has not scrolled away", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    geometry(tab.thread, 1000, 400, 0);
    const f = c.follower(tab.thread);
    f.follow();
    expect(tab.thread.scrollTop).toBe(1000);
  });

  it("stops following once the operator scrolls up, and offers a way back", () => {
    const { doc, c } = loadConsole();
    const tab = chatTab(c, doc);
    geometry(tab.thread, 1000, 400, 600);
    const f = c.follower(tab.thread);
    const pill = tab.pane.querySelector(".jump")!;
    expect(pill.style.display).toBe("none");
    tab.thread.scrollTop = 100; // scrolled up mid-turn
    tab.thread.dispatchEvent(new (doc.defaultView as any).Event("scroll"));
    expect(pill.style.display).not.toBe("none");
    f.follow();
    expect(tab.thread.scrollTop).toBe(100); // it did NOT yank them back down
    pill.click();
    expect(tab.thread.scrollTop).toBe(1000); // …until they asked for it
    expect(pill.style.display).toBe("none");
  });
});

describe("chat — titling", () => {
  it("cuts a long first message at a word boundary, not mid-word", () => {
    const { c } = loadConsole();
    const t = c.chatTitle("Can you check whether the Q3 invoices were reconciled properly");
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/\s…$/);
    expect(t.length).toBeLessThanOrEqual(35);
    expect("Can you check whether the Q3 invoices were reconciled properly").toContain(t.slice(0, -1));
  });

  it("prefers the first sentence, and strips markdown noise", () => {
    const { c } = loadConsole();
    expect(c.chatTitle("**Fix the payroll bug.** Then tell me why it happened.")).toBe("Fix the payroll bug.");
  });

  it("leaves a short message alone", () => {
    const { c } = loadConsole();
    expect(c.chatTitle("hi")).toBe("hi");
  });
});

describe("chat — composer", () => {
  /** Build a composer on a bare tab and hand back the pieces the tests poke at. */
  function composer(c: Record<string, any>, doc: any, handlers?: any) {
    const tab: any = { id: "t1", sessionId: "s1", sent: [] };
    const sent: string[] = [];
    let stopped = 0;
    const cmp = c.buildComposer(tab, handlers || { onSend: (p: string) => sent.push(p), onStop: () => stopped++ });
    doc.body.appendChild(cmp.el);
    return { tab, cmp, sent, ta: cmp.el.querySelector("textarea"), send: cmp.el.querySelector(".send"), stopped: () => stopped };
  }

  const key = (doc: any, ta: any, k: string, extra?: any) => {
    const e = new (doc.defaultView as any).KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...(extra || {}) });
    ta.dispatchEvent(e);
    return e;
  };

  // The picker IS the visible "active model" indicator, so it must name real, versioned models and
  // default to the one that actually runs. This was lost once already when the composer was split
  // out of chat.js — pinned here so a refactor can't quietly drop it again.
  it("offers the real versioned model names, defaulting to the pinned Sonnet 5", () => {
    const { doc, c } = loadConsole();
    const t = composer(c, doc);
    const sel = t.cmp.el.querySelector(".modelsel")!;
    expect([...sel.querySelectorAll("option")].map((o: any) => o.value)).toEqual(["sonnet", "opus", "haiku", "fable"]);
    expect([...sel.querySelectorAll("option")].map((o: any) => o.textContent)).toEqual([
      "Sonnet 5",
      "Opus 4.8",
      "Haiku 4.5",
      "Fable 5",
    ]);
    expect(sel.value).toBe("sonnet"); // no saved choice → the pinned default, never a vague blank
  });

  it("shows a tab's saved model choice rather than the default", () => {
    const { doc, c } = loadConsole();
    const tab: any = { id: "t1", sessionId: "s1", model: "opus", sent: [] };
    const cmp = c.buildComposer(tab, { onSend() {}, onStop() {} });
    expect(cmp.el.querySelector(".modelsel").value).toBe("opus");
  });

  it("sends on Enter and keeps a newline on Shift+Enter", () => {
    const { doc, c } = loadConsole();
    const t = composer(c, doc);
    t.ta.value = "ship it";
    key(doc, t.ta, "Enter");
    expect(t.sent).toEqual(["ship it"]);
    expect(t.ta.value).toBe("");
    t.ta.value = "line";
    const e = key(doc, t.ta, "Enter", { shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(t.sent).toHaveLength(1);
  });

  it("flips Send to Stop while a turn runs, and Stop calls the handler", () => {
    const { doc, c } = loadConsole();
    const t = composer(c, doc);
    expect(t.send.textContent).toBe("Send");
    t.cmp.setBusy(true);
    expect(t.send.textContent).toBe("Stop");
    t.send.click();
    expect(t.stopped()).toBe(1);
    t.ta.value = "queued";
    key(doc, t.ta, "Enter");
    expect(t.sent).toHaveLength(0); // Enter is inert while busy — you can type ahead, not double-send
  });

  it("Escape stops a running turn", () => {
    const { doc, c } = loadConsole();
    const t = composer(c, doc);
    t.cmp.setBusy(true);
    key(doc, t.ta, "Escape");
    expect(t.stopped()).toBe(1);
  });

  it("keeps the draft on the tab so a pane rebuild loses nothing", () => {
    const { doc, c } = loadConsole();
    const t = composer(c, doc);
    t.ta.value = "half-written thought";
    t.ta.dispatchEvent(new (doc.defaultView as any).Event("input"));
    expect(t.tab.draft).toBe("half-written thought");
    const again = c.buildComposer(t.tab, { onSend() {}, onStop() {} });
    expect(again.value()).toBe("half-written thought");
  });

  it("recalls previously sent messages with ArrowUp, and walks back down", () => {
    const { doc, c } = loadConsole();
    const t = composer(c, doc);
    t.ta.value = "first";
    key(doc, t.ta, "Enter");
    t.ta.value = "second";
    key(doc, t.ta, "Enter");
    key(doc, t.ta, "ArrowUp");
    expect(t.ta.value).toBe("second");
    key(doc, t.ta, "ArrowUp");
    expect(t.ta.value).toBe("first");
    key(doc, t.ta, "ArrowDown");
    expect(t.ta.value).toBe("second");
    key(doc, t.ta, "ArrowDown");
    expect(t.ta.value).toBe("");
  });

  it("completes /commands typed at the start of the box", async () => {
    const { doc, c } = loadConsole();
    const t = composer(c, doc);
    t.ta.value = "/pl";
    t.ta.selectionStart = t.ta.selectionEnd = 3;
    t.ta.dispatchEvent(new (doc.defaultView as any).Event("input"));
    await Promise.resolve();
    const menu = t.cmp.el.querySelector(".cmenu")!;
    expect(menu.style.display).not.toBe("none");
    expect(menu.querySelector(".cmi-l")!.textContent).toBe("/plan");
    (menu.querySelector(".cmi") as any).click();
    expect(t.ta.value).toContain("draft a short plan");
    expect(menu.style.display).toBe("none");
  });

  it("completes @file mentions from the workspace tree", async () => {
    const { doc, c } = loadConsole();
    c.S.tree = [{ type: "dir", children: [{ type: "file", path: "docs/model.md" }, { type: "file", path: "docs/charter.md" }] }];
    const t = composer(c, doc);
    t.ta.value = "look at @char";
    t.ta.selectionStart = t.ta.selectionEnd = t.ta.value.length;
    t.ta.dispatchEvent(new (doc.defaultView as any).Event("input"));
    await Promise.resolve();
    await Promise.resolve();
    const menu = t.cmp.el.querySelector(".cmenu")!;
    expect(menu.querySelectorAll(".cmi")).toHaveLength(1);
    (menu.querySelector(".cmi") as any).click();
    expect(t.ta.value).toBe("look at @docs/charter.md ");
  });

  it("does not treat a mid-message slash (a path) as a command", async () => {
    const { doc, c } = loadConsole();
    const t = composer(c, doc);
    t.ta.value = "see apps/client";
    t.ta.selectionStart = t.ta.selectionEnd = t.ta.value.length;
    t.ta.dispatchEvent(new (doc.defaultView as any).Event("input"));
    await Promise.resolve();
    expect(t.cmp.el.querySelector(".cmenu")!.style.display).toBe("none");
  });
});

describe("chat — dropped files", () => {
  it("turns a file under a repo root into an @path the agent can read", () => {
    const { c } = loadConsole();
    c.S.config = { roots: ["/Users/x/co/core"] };
    expect(c.repoRelative("/Users/x/co/core/docs/model.md")).toBe("docs/model.md");
  });

  it("refuses a file outside every root rather than inventing a path", () => {
    const { c } = loadConsole();
    c.S.config = { roots: ["/Users/x/co/core"] };
    expect(c.repoRelative("/Users/x/Desktop/secret.pdf")).toBeNull();
    expect(c.repoRelative("/Users/x/co/core-evil/x.md")).toBeNull(); // prefix ≠ containment
  });
});
