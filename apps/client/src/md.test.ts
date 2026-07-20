// Hermetic tests for the operator-console markdown renderer (web/md.js), extracted from
// index.html's inline script so this suite can pin it (stored XSS in md()).
// Two classes of assertion:
//   1. Hostile link targets render inert - the two adversarially-verified payloads plus the
//      scheme allowlist and attribute quote-escaping.
//   2. Benign markdown renders *byte-identical* to the pre-fix renderer - the expected strings
//      below were captured from the original inline md() before the extraction/fix.
import { describe, it, expect } from "vitest";
import "../web/md.js";

describe("esc / escAttr", () => {
  it("esc escapes text-context metacharacters and nothing else", () => {
    expect(esc('<b>&"\'</b>')).toBe('&lt;b&gt;&amp;"\'&lt;/b&gt;');
    expect(esc(null)).toBe("");
  });

  it("escAttr additionally escapes both quote kinds (attribute context)", () => {
    expect(escAttr('<b>&"\'</b>')).toBe("&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;");
    expect(escAttr(undefined)).toBe("");
  });
});

describe("md() link targets (stored-XSS fix, A1)", () => {
  it("neutralizes a javascript: link - renders the raw markdown as plain text, no anchor", () => {
    const out = md("[click me](javascript:alert(document.domain))");
    expect(out).toBe("<p>[click me](javascript:alert(document.domain))</p>");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("href");
  });

  it("neutralizes the attribute-breakout payload - quotes stay entity-escaped inside href", () => {
    const out = md('[x](https://x.co/"onmouseover="alert(1))');
    expect(out).toBe(
      '<p><a href="https://x.co/&quot;onmouseover=&quot;alert(1" target="_blank" rel="noopener">x</a>)</p>',
    );
    // The payload must not surface as a real attribute: no raw quote may appear inside the
    // interpolated URL, so the tag has exactly the three intended attributes.
    expect(out).not.toMatch(/onmouseover\s*=\s*"/);
  });

  it("refuses every non-allowlisted scheme (data:, vbscript:, file:)", () => {
    const out = md("[d](data:text/html,x) [v](vbscript:x) [f](file:///etc/passwd)");
    expect(out).toBe("<p>[d](data:text/html,x) [v](vbscript:x) [f](file:///etc/passwd)</p>");
  });

  it("renders scheme-less relative links (brain cross-references), but not protocol-relative ones", () => {
    // The operator's own docs link to each other by relative path - these must render as links.
    expect(md("See [the model](model.md).")).toBe(
      '<p>See <a href="model.md" target="_blank" rel="noopener">the model</a>.</p>',
    );
    expect(md("the [decision log](../decisions/log.md)")).toBe(
      '<p>the <a href="../decisions/log.md" target="_blank" rel="noopener">decision log</a></p>',
    );
    // Off-origin tricks are NOT safe relative paths - they stay raw: protocol-relative `//host`,
    // the `\\host` form browsers normalize to it, and a root-relative `/path`.
    expect(md("[x](//evil.example/p)")).toBe("<p>[x](//evil.example/p)</p>");
    expect(md("[x](\\\\evil.example\\p)")).toBe("<p>[x](\\\\evil.example\\p)</p>");
    expect(md("[x](/api/gate)")).toBe("<p>[x](/api/gate)</p>");
  });

  it("allows https, http, and mailto - case-insensitively", () => {
    expect(md("[up](HTTPS://X.co/p)")).toBe(
      '<p><a href="HTTPS://X.co/p" target="_blank" rel="noopener">up</a></p>',
    );
    expect(md("[h](http://x.co/)")).toBe(
      '<p><a href="http://x.co/" target="_blank" rel="noopener">h</a></p>',
    );
    expect(md("Mail [me](mailto:a@b.co).")).toBe(
      '<p>Mail <a href="mailto:a@b.co" target="_blank" rel="noopener">me</a>.</p>',
    );
  });

  it("quote-escapes allowed URLs without double-encoding ampersands", () => {
    expect(md("[q](https://x.co/a'b\"c)")).toBe(
      '<p><a href="https://x.co/a&#39;b&quot;c" target="_blank" rel="noopener">q</a></p>',
    );
    // & went through esc() once (&amp;) and must NOT become &amp;amp; in the attribute.
    expect(md("See [docs](https://example.com/a?b=1&c=2) now")).toBe(
      '<p>See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener">docs</a> now</p>',
    );
  });
});

describe("md() benign rendering", () => {
  // Pinned output for the everyday cases. Where a line differs from the pre-rewrite regex renderer
  // it is called out: the block parser fixes two real bugs the old pass had — a fenced block used to
  // be emitted INSIDE the surrounding <p>, and a block following a heading was left unwrapped.
  const baseline: Array<[name: string, input: string, expected: string]> = [
    ["heading + paragraph", "# Title\n\nSome text", "<h1>Title</h1>\n<p>Some text</p>"],
    // was "<h4>Deep</h4>\npara" — the trailing text is a paragraph and is now wrapped as one.
    ["h4", "#### Deep\npara", "<h4>Deep</h4>\n<p>para</p>"],
    [
      "strong/em/code",
      "This is **bold** and *ital* and `code`.",
      "<p>This is <strong>bold</strong> and <em>ital</em> and <code>code</code>.</p>",
    ],
    ["strikethrough", "a ~~gone~~ b", "<p>a <del>gone</del> b</p>"],
    [
      "bulleted + numbered lists",
      "- one\n- two\n\n1. first\n2. second",
      "<ul><li>one</li><li>two</li></ul>\n<ol><li>first</li><li>second</li></ol>",
    ],
    [
      "nested list",
      "- one\n  - a\n  - b\n- two",
      "<ul><li>one<ul><li>a</li><li>b</li></ul></li><li>two</li></ul>",
    ],
    ["task list", "- [ ] todo\n- [x] done", '<ul><li class="task">☐ todo</li><li class="task">☑ done</li></ul>'],
    ["horizontal rule", "a\n\n---\n\nb", "<p>a</p>\n<hr>\n<p>b</p>"],
    [
      "blockquote",
      "> quoted **b**\n> more\n\nafter",
      "<blockquote><p>quoted <strong>b</strong><br>more</p></blockquote>\n<p>after</p>",
    ],
    [
      // was "<p>Before 42 lines<br> <pre>…</pre> <br>After 99 words</p>" — a <pre> nested in a <p>.
      "code fence with digits in surrounding prose",
      "Before 42 lines\n```js\nconst n = 7;\n```\nAfter 99 words",
      '<p>Before 42 lines</p>\n<pre class="cb" data-lang="js"><code>const n = 7;</code></pre>\n<p>After 99 words</p>',
    ],
    [
      "plain fence surrounded by digit-bearing text",
      "Count 0 and 1.\n```\nplain 0 1 2\n```\nTail 3",
      '<p>Count 0 and 1.</p>\n<pre class="cb"><code>plain 0 1 2</code></pre>\n<p>Tail 3</p>',
    ],
    [
      "paragraph breaks vs soft breaks",
      "First para\nsame para line\n\nSecond para",
      "<p>First para<br>same para line</p>\n<p>Second para</p>",
    ],
  ];

  for (const [name, input, expected] of baseline) {
    it(name, () => {
      expect(md(input)).toBe(expected);
    });
  }

  it("renders a pipe table with per-column alignment", () => {
    expect(md("| a | b |\n|:--|--:|\n| 1 | 2 |")).toBe(
      '<table><thead><tr><th style="text-align:left">a</th><th style="text-align:right">b</th></tr></thead>' +
        '<tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr></tbody></table>',
    );
  });

  it("pads a ragged table row to the header width instead of breaking the grid", () => {
    const out = md("| a | b |\n|---|---|\n| 1 |");
    expect(out).toContain("<td>1</td><td></td>");
  });

  it("leaves markup inside a code span literal", () => {
    expect(md("use `**not bold**` here")).toBe("<p>use <code>**not bold**</code> here</p>");
  });
});

// The chat pane re-renders the agent's answer on EVERY streamed token, so half-written markdown is
// the normal input, not an edge case. These pin that a truncated document still renders as the
// document it is becoming - never as raw syntax leaking into the prose.
describe("md() streaming tolerance", () => {
  it("renders an unclosed fence as an open code block, not literal backticks", () => {
    const out = md("Here you go:\n```js\nconst n = 7;");
    expect(out).toBe('<p>Here you go:</p>\n<pre class="cb cb-open" data-lang="js"><code>const n = 7;</code></pre>');
    expect(out).not.toContain("```");
  });

  it("marks the block closed as soon as the closing fence arrives", () => {
    expect(md("```\nx\n```")).toBe('<pre class="cb"><code>x</code></pre>');
  });

  it("never emits raw backticks while a fence is being typed character by character", () => {
    const full = "Answer:\n```py\nprint(1)\n```\nDone.";
    for (let n = 1; n <= full.length; n++) expect(md(full.slice(0, n)), full.slice(0, n)).not.toContain("```");
  });

  it("degrades a half-typed table to text rather than an empty grid", () => {
    expect(md("| a | b |")).toBe("<p>| a | b |</p>"); // no divider yet → not a table
  });

  it("keeps every prefix escaped (a hostile answer stays inert while it streams)", () => {
    const hostile = 'here <img src=x onerror=alert(1)> and [z](javascript:alert(2))';
    for (let n = 1; n <= hostile.length; n++) {
      const out = md(hostile.slice(0, n));
      expect(out, hostile.slice(0, n)).not.toContain("<img");
      expect(out).not.toContain("javascript:alert(2)\"");
    }
  });
});

describe("mdBlocks() - the incremental-render seam", () => {
  it("returns one entry per top-level block, and md() is just those joined", () => {
    const src = "# T\n\npara\n\n- a\n- b";
    expect(mdBlocks(src)).toEqual(["<h1>T</h1>", "<p>para</p>", "<ul><li>a</li><li>b</li></ul>"]);
    expect(md(src)).toBe(mdBlocks(src).join("\n"));
  });

  it("keeps a stable prefix as text is appended - this is what makes streaming cheap", () => {
    // Appending to the last block must not disturb the blocks before it; the chat pane relies on
    // that to leave earlier DOM (and any live text selection inside it) untouched.
    const a = mdBlocks("# T\n\nfirst para\n\nsecond par");
    const b = mdBlocks("# T\n\nfirst para\n\nsecond paragraph");
    expect(b.slice(0, 2)).toEqual(a.slice(0, 2));
    expect(b[2]).not.toBe(a[2]);
  });
});

describe("md() GFM tables", () => {
  it("renders a header + separator + body rows into a <table>", () => {
    const out = md("| Name | Tools |\n| --- | --- |\n| Asana | 46 |\n| Calendly | 36 |");
    expect(out).toBe(
      "<table><thead><tr><th>Name</th><th>Tools</th></tr></thead>" +
        "<tbody><tr><td>Asana</td><td>46</td></tr><tr><td>Calendly</td><td>36</td></tr></tbody></table>",
    );
  });

  it("keeps surrounding prose as its own paragraphs", () => {
    const out = md("Here:\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nDone.");
    expect(out).toBe(
      "<p>Here:</p>\n<table><thead><tr><th>A</th><th>B</th></tr></thead>" +
        "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>\n<p>Done.</p>",
    );
  });

  it("honors column alignment from separator colons", () => {
    const out = md("| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |");
    expect(out).toContain('<th style="text-align:left">L</th>');
    expect(out).toContain('<th style="text-align:center">C</th>');
    expect(out).toContain('<th style="text-align:right">R</th>');
    expect(out).toContain('<td style="text-align:center">b</td>');
  });

  it("renders inline formatting inside cells", () => {
    const out = md("| Field | Value |\n| --- | --- |\n| **bold** | `code` |");
    expect(out).toContain("<td><strong>bold</strong></td>");
    expect(out).toContain("<td><code>code</code></td>");
  });

  it("degrades gracefully mid-stream: a header with no separator yet stays a paragraph", () => {
    // addText re-parses the full accumulated markdown on every chunk, so an incomplete table must
    // not throw or emit a broken <table> before its separator row has arrived.
    expect(md("| Name | Tools |")).toBe("<p>| Name | Tools |</p>");
  });

  it("does not mistake a pipe-bearing sentence for a table", () => {
    expect(md("use a | b to pipe, and x - y to dash")).toBe(
      "<p>use a | b to pipe, and x - y to dash</p>",
    );
  });
});
