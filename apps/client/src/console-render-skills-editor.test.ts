// Browser test net for the operator console — the skills panel, the chat history
// replay, and the WYSIWYG markdown editor's serializers. Loads the REAL bundle into jsdom (see
// console-harness.ts) and asserts renderer/serializer output, above all that operator/agent-supplied
// text (skill names, commit-ish subjects, tool names, document content) is ESCAPED not injected — the
// property the innerHTML→builder migration must preserve. Sibling surfaces live in the other
// console-render-*.test.ts files.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

describe("console skill/editor helpers (jsdom) — pure serializers", () => {
  it("stripFrontmatter drops a leading YAML block and leaves body untouched", () => {
    const { c } = loadConsole();
    const src = "---\ndescription: Use when X\n---\n# Body\ntext";
    expect(c.stripFrontmatter(src)).toBe("# Body\ntext");
    expect(c.stripFrontmatter("# no frontmatter\nplain")).toBe("# no frontmatter\nplain");
  });

  it("parseSkill pulls the description field and returns the stripped body", () => {
    const { c } = loadConsole();
    const src = "---\nname: weekly-review\ndescription:   Use when the week closes  \n---\n## Steps\n- do it";
    const pr = c.parseSkill(src);
    expect(pr.description).toBe("Use when the week closes");
    expect(pr.body).toBe("## Steps\n- do it");
  });

  it("wysiInline serializes nested inline formatting to markdown", () => {
    const { doc, c } = loadConsole();
    const d = doc as unknown as { body: { innerHTML: string } };
    d.body.innerHTML = "<strong>hi</strong> <em>x</em> <code>a&lt;b</code> <a href=\"https://x.co\">lnk</a>";
    expect(c.wysiInline(d.body)).toBe("**hi** *x* `a<b` [lnk](https://x.co)");
  });

  it("wysiInline recurses into nested emphasis", () => {
    const { doc, c } = loadConsole();
    const d = doc as unknown as { body: { innerHTML: string } };
    d.body.innerHTML = "<strong>a <em>b</em></strong>";
    expect(c.wysiInline(d.body)).toBe("**a *b***");
  });

  it("wysiToMd serializes block structure to a markdown document", () => {
    const { doc, c } = loadConsole();
    const d = doc as unknown as { body: { innerHTML: string } };
    d.body.innerHTML = "<h2>Title</h2><p>para <strong>b</strong></p><ul><li>one</li><li>two</li></ul>";
    expect(c.wysiToMd(d.body)).toBe("## Title\n\npara **b**\n\n- one\n- two\n");
  });

  it("editor round-trip keeps an XSS payload inert as text, never a live element", () => {
    const { doc, c } = loadConsole();
    const d = doc as unknown as { body: { innerHTML: string }; querySelector(s: string): unknown };
    const payload = "<img src=x onerror=alert(1)>";
    // markdown → HTML: the payload must render as escaped text, not a real <img>.
    d.body.innerHTML = c.md(payload);
    expect(d.querySelector("img")).toBeNull();
    // HTML → markdown: it survives as literal text …
    const back = c.wysiToMd(d.body as unknown);
    expect(back).toContain("<img");
    // … and re-rendering it still yields no live element (round-trip is XSS-safe).
    d.body.innerHTML = c.md(back);
    expect(d.querySelector("img")).toBeNull();
  });
});

describe("console renderers (jsdom) — chat history replay", () => {
  it("replays an operator message into a bubble and closes the agent turn", () => {
    const { doc, c } = loadConsole();
    const d = doc as unknown as { createElement(t: string): { appendChild(n: unknown): void; querySelector(s: string): { textContent: string } | null; querySelectorAll(s: string): ArrayLike<unknown> }; body: { appendChild(n: unknown): void } };
    const thread = d.createElement("div");
    d.body.appendChild(thread);
    c.renderHistory({ thread }, [
      { kind: "text", text: "Summarize Q3" },
      { kind: "tool", name: "Read", path: "docs/q3.md", id: "t1" },
      { kind: "done" },
    ]);
    expect(thread.querySelector(".bubble.op")!.textContent).toContain("Summarize Q3");
    expect(thread.querySelectorAll(".turn")).toHaveLength(2); // operator + agent
    expect(thread.querySelector(".tk")!.textContent).toBe("Read");
  });

  it("ESCAPES an XSS-y operator message — the payload is inert text, never a live element", () => {
    const { doc, c } = loadConsole();
    const d = doc as unknown as { createElement(t: string): { querySelector(s: string): { textContent: string } | null }; body: { appendChild(n: unknown): void } };
    const thread = d.createElement("div");
    d.body.appendChild(thread);
    c.renderHistory({ thread }, [{ kind: "text", text: "<img src=x onerror=alert(1)>" }]);
    expect(thread.querySelector("img")).toBeNull(); // never became a real element
    expect(thread.querySelector(".bubble.op")!.textContent).toContain("<img"); // survives as text
  });

  it("ESCAPES an XSS-y tool name and path from the agent stream", () => {
    const { doc, c } = loadConsole();
    const d = doc as unknown as { createElement(t: string): { querySelector(s: string): { textContent: string } | null }; body: { appendChild(n: unknown): void } };
    const thread = d.createElement("div");
    d.body.appendChild(thread);
    c.renderHistory({ thread }, [{ kind: "tool", name: "<img src=x onerror=alert(1)>", path: "<b>oops</b>", id: "t1" }]);
    expect(thread.querySelector("img")).toBeNull();
    expect(thread.querySelector("b")).toBeNull();
    expect(thread.querySelector(".tk")!.textContent).toContain("<img"); // inert text
  });
});

describe("console renderers (jsdom) — skills panel", () => {
  it("renders the panel header + empty state when no skills load", async () => {
    const { doc, c } = loadConsole();
    c.S.rightTab = "skills";
    await c.rSkills(); // fetch is stubbed to reject → the empty state renders
    expect(doc.querySelector("#rpanel .rhead h4")!.textContent).toContain("Skills");
    expect(doc.querySelector("#newSkill")).not.toBeNull();
    expect(doc.querySelector("#rl .rmini")!.textContent).toContain("No verbs yet");
  });
});
