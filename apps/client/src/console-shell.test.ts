// Integrity net for the operator-console module split. The console used to be one
// 1,588-line index.html; it is now a shell that loads md.js + ordered classic-script modules from
// web/js/ and a design-system stylesheet set from web/styles/. The DOM-level renderer tests live in
// console-render*.test.ts (the jsdom net, C2); these checks guard the split STRUCTURALLY without a
// DOM (asset integrity + CSP hygiene + one-program compile/load), which the jsdom net does not:
//   1. every <script src>/<link href> the shell references exists on disk, and no module is orphaned;
//   2. the shell carries no inline <script> body and no on*= handlers (so the tightened CSP holds);
//   3. md.js + all js/ modules concatenate into one program that COMPILES — which, because classic
//      scripts share a single global scope, catches syntax errors AND any duplicate top-level
//      `const`/`let`/`function` declaration across modules (a real hazard of splitting one script).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const html = readFileSync(join(WEB, "index.html"), "utf8");

// group 1 is always present when the pattern matches, so the assertion is safe.
const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]!);
const linkHrefs = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)">/g)].map((m) => m[1]!);
// Markup only — comments legitimately mention "<script>" and "on*=" while describing the CSP.
const markup = html.replace(/<!--[\s\S]*?-->/g, "");

describe("console shell — referenced assets", () => {
  it("references md.js + dom.js first, then only js/ modules", () => {
    expect(scriptSrcs[0]).toBe("md.js"); // esc/escAttr/md the modules build on
    expect(scriptSrcs[1]).toBe("dom.js"); // the safe DOM builder (el/txt/frag), before any renderer
    expect(scriptSrcs.slice(2).every((s) => s.startsWith("js/"))).toBe(true);
    expect(scriptSrcs[scriptSrcs.length - 1]).toBe("js/main.js"); // boot() runs last
  });

  it("every referenced script and stylesheet exists on disk", () => {
    for (const src of scriptSrcs) expect(existsSync(join(WEB, src)), src).toBe(true);
    for (const href of linkHrefs) expect(existsSync(join(WEB, href)), href).toBe(true);
    expect(linkHrefs.length).toBeGreaterThan(0);
  });

  it("no js/ module is orphaned (every file on disk is loaded by the shell)", () => {
    const onDisk = readdirSync(join(WEB, "js")).filter((f) => f.endsWith(".js")).sort();
    const loaded = scriptSrcs.filter((s) => s.startsWith("js/")).map((s) => s.slice(3)).sort();
    expect(loaded).toEqual(onDisk);
  });
});

describe("console shell — CSP-relevant hygiene", () => {
  it("carries no inline <script> body (all script is external)", () => {
    // every <script> tag in the markup must have a src="…" and an empty body
    expect(markup).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(markup).not.toMatch(/<script[^>]*>[^<]/); // no text between <script …> and </script>
  });

  it("carries no inline on*= event handlers (CSP drops script-src 'unsafe-inline')", () => {
    expect(markup).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
  });

  it("the CSP no longer allows 'unsafe-inline' for scripts", () => {
    const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});

const bundle = (files: string[]) => files.map((f) => readFileSync(join(WEB, f), "utf8")).join("\n;\n");

describe("console modules — the split is one valid program", () => {
  it("md.js + all js/ modules compile together with no syntax or redeclaration error", () => {
    const order = scriptSrcs; // md.js + dom.js + every js/ module in shell order
    // new vm.Script compiles (parses) without executing — no document/fetch needed. Because the
    // console's classic scripts share one global scope, a duplicate top-level `const S` (etc.)
    // across two modules is an early SyntaxError here, exactly as it would be in the browser.
    expect(() => new vm.Script(bundle(order), { filename: "console-bundle.js" })).not.toThrow();
  });

  it("loads top-to-bottom without a forward-reference/TDZ error, exposing the expected globals", () => {
    // Execute every module EXCEPT js/main.js (which calls the DOM-heavy boot()). This runs all
    // top-level code in one shared scope — the real hazard of a classic-script split: a top-level
    // statement in an early module referencing a symbol a later module declares would throw here,
    // exactly as in the browser. Light stubs cover the only globals touched at load time
    // (navigator for IS_MAC, document.addEventListener for the navmenu click-away listener).
    const order = scriptSrcs.filter((s) => s !== "js/main.js"); // md.js + dom.js + js/ modules, minus boot
    const probe = `;globalThis.__probe={boot:typeof boot,md:typeof md,esc:typeof esc,switchRight:typeof switchRight,S:typeof S,sKeys:(typeof S==="object"&&S)?Object.keys(S):[]};`;
    const sandbox: Record<string, unknown> = {
      navigator: { platform: "MacIntel", userAgent: "vitest" },
      document: { addEventListener() {}, body: { classList: { add() {} } } },
      localStorage: { getItem: () => null, setItem() {} },
      matchMedia: () => ({ matches: false }),
      setInterval: () => 0,
      setTimeout: () => 0,
      fetch: () => Promise.reject(new Error("no network in this smoke")),
      console: { log() {}, warn() {}, error() {} },
    };
    sandbox["globalThis"] = sandbox;
    expect(() => vm.runInNewContext(bundle(order) + probe, sandbox, { filename: "console-load.js" })).not.toThrow();
    const p = sandbox["__probe"] as Record<string, unknown>;
    expect(p.boot).toBe("function"); // defined in boot.js, referenced by main.js
    expect(p.md).toBe("function"); // md.js loaded first
    expect(p.esc).toBe("function");
    expect(p.switchRight).toBe("function"); // right-rail.js
    expect(p.S).toBe("object"); // shared state initialized
    expect(p.sKeys).toContain("tabs"); // S is the real state object, not an empty stub
  });
});
