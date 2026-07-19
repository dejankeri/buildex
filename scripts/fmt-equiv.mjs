#!/usr/bin/env node
// Prove a change is FORMATTING + COMMENTS ONLY (no behavior change) by comparing two files'
// abstract syntax trees via the TypeScript compiler. Used to verify the console reformat
// (web/js/*.js): a reformatted module must be AST-identical to the version
// it replaced.
//
//   node scripts/fmt-equiv.mjs <fileA> <fileB>
//
// The walk compares each node's `kind`, its leaf value (identifier name / literal text), and the
// two semantic fields `forEachChild` does NOT expose as child nodes — the unary operator (a++ vs
// a--, !x vs -x) and the const/let/var flag. Everything a formatting pass may change (whitespace,
// line breaks, comments, string-quote style, redundant parens around a single arrow param) is
// invisible to an AST comparison. Any real change (reordered/dropped statement, flipped operator,
// const->let, different identifier or literal, added/removed expression parens) is reported with
// its path. NB: this treats added/removed EXPRESSION parentheses ((a+b) vs a+b) as a difference —
// a reformat must leave parentheses exactly as they were.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// resolve the repo's own typescript (this script lives in <repo>/scripts)
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
const ts = require("typescript");

const parse = (file) =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);

const kids = (n) => {
  const out = [];
  // forEachChild stops if the callback returns truthy, and arr.push returns the new length — so the
  // body must NOT return a value, or only the first child is ever collected.
  n.forEachChild((c) => {
    out.push(c);
  });
  return out;
};

const leaf = (n) => {
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return "id:" + n.escapedText;
  if (
    ts.isStringLiteralLike(n) ||
    ts.isNumericLiteral(n) ||
    ts.isBigIntLiteral(n) ||
    n.kind === ts.SyntaxKind.RegularExpressionLiteral ||
    n.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    ts.isTemplateHead(n) ||
    ts.isTemplateMiddle(n) ||
    ts.isTemplateTail(n)
  )
    return "lit:" + n.text;
  return "";
};

const extra = (n) => {
  const bits = [];
  if (n.kind === ts.SyntaxKind.PrefixUnaryExpression || n.kind === ts.SyntaxKind.PostfixUnaryExpression)
    bits.push("op:" + ts.tokenToString(n.operator));
  if (n.kind === ts.SyntaxKind.VariableDeclarationList)
    bits.push("decl:" + (n.flags & ts.NodeFlags.Const ? "const" : n.flags & ts.NodeFlags.Let ? "let" : "var"));
  return bits.join(",");
};

function diff(a, b, path) {
  if (a.kind !== b.kind) return { path, a: ts.SyntaxKind[a.kind], b: ts.SyntaxKind[b.kind] };
  const la = leaf(a), lb = leaf(b);
  if (la !== lb) return { path, a: la, b: lb };
  const ea = extra(a), eb = extra(b);
  if (ea !== eb) return { path, a: ea, b: eb };
  const ca = kids(a), cb = kids(b);
  if (ca.length !== cb.length)
    return { path, a: `${ca.length} children of ${ts.SyntaxKind[a.kind]}`, b: `${cb.length} children` };
  for (let i = 0; i < ca.length; i++) {
    const d = diff(ca[i], cb[i], `${path}/${ts.SyntaxKind[ca[i].kind]}`);
    if (d) return d;
  }
  return null;
}

const [af, bf] = process.argv.slice(2);
if (!af || !bf) {
  console.error("usage: node scripts/fmt-equiv.mjs <fileA> <fileB>");
  process.exit(2);
}
const d = diff(parse(af), parse(bf), "");
if (!d) {
  console.log(`EQUIVALENT ✓  ${af}  ==(AST)==  ${bf}`);
} else {
  console.log(`DIFFERENT ✗  not a formatting-only change:`);
  console.log(`   at ${d.path || "(root)"}`);
  console.log(`   A: ${d.a}`);
  console.log(`   B: ${d.b}`);
  process.exit(1);
}
