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

describe("md() benign rendering - identical to the pre-fix renderer", () => {
  // Captured verbatim from the original inline md() in index.html before the A1 change.
  const baseline: Array<[name: string, input: string, expected: string]> = [
    ["heading + paragraph", "# Title\n\nSome text", "<h1>Title</h1>\n<p>Some text</p>"],
    ["h4", "#### Deep\npara", "<h4>Deep</h4>\npara"],
    [
      "strong/em/code",
      "This is **bold** and *ital* and `code`.",
      "<p>This is <strong>bold</strong> and <em>ital</em> and <code>code</code>.</p>",
    ],
    [
      "bulleted + numbered lists",
      "- one\n- two\n\n1. first\n2. second",
      "<ul><li>one</li><li>two</li></ul>\n<ol><li>first</li><li>second</li></ol>",
    ],
    [
      "code fence with digits in surrounding prose",
      "Before 42 lines\n```js\nconst n = 7;\n```\nAfter 99 words",
      "<p>Before 42 lines<br> <pre><code>const n = 7;</code></pre> <br>After 99 words</p>",
    ],
    [
      "plain fence surrounded by digit-bearing text",
      "Count 0 and 1.\n```\nplain 0 1 2\n```\nTail 3",
      "<p>Count 0 and 1.<br> <pre><code>plain 0 1 2</code></pre> <br>Tail 3</p>",
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
