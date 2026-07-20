# Vendored third-party code

Files here are **not ours**. They are copied in verbatim, committed, and served from `'self'` — the
console's CSP (`script-src 'self'`, see `web/index.html`) forbids loading script from a CDN, and the
console has no build step that could pull something out of `node_modules`. Vendoring is the only
route that keeps the CSP intact.

The rules for anything added to this directory:

1. **License must be MIT-compatible, and its file ships next to the code.** The monorepo is MIT; a
   vendored file keeps its own license and its own copyright header. Never strip the banner comment.
2. **Record the exact version and the integrity hash below**, verified against the publisher at the
   time of vendoring. A future update re-verifies rather than trusting the diff.
3. **Never edit a vendored file.** If it needs a change, wrap it from our own code. An edited vendor
   file cannot be re-verified against upstream, which defeats the point of the hash.
4. **Update deliberately.** There is no `npm update` here: a security fix upstream is something we
   have to notice. Re-download, re-verify the hash, replace the file, re-run `task ci`.

## Inventory

### highlight.js

| | |
|---|---|
| File | `highlight.min.js` |
| Version | 11.11.1 (git `08cb242e7d`) |
| License | BSD-3-Clause — `highlight.js-LICENSE` |
| Copyright | (c) 2006 Ivan Sagalaev; (c) 2006-2024 Josh Goebel and contributors |
| Source | `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js` |
| Integrity | `sha512-EBLzUL8XLl+va/zAsmXwS7Z2B1F9HUHkZwyS/VKwh3S7T/U0nF4BaU29EP/ZSf6zgiIxYAnKLu6bJ8dqpmX5uw==` |
| Vendored | 2026-07-20, verified against the cdnjs published SRI |

Used by `web/js/chat-turn.js` to colour a *closed* fenced code block in the chat thread. Its use is
**optional by construction**: every call site checks `typeof hljs`, so the console renders correctly
with this file absent — which is also how the jsdom test harness runs (it skips `vendor/`, so 130KB
of grammar tables aren't parsed once per renderer test).

Themeing is ours, not upstream's: `web/styles/chat.css` maps the `.hljs-*` classes onto the console's
design tokens, so highlighting follows the light/dark theme instead of shipping a fixed palette.

To re-verify this file:

```sh
openssl dgst -sha512 -binary apps/client/web/vendor/highlight.min.js | openssl base64 -A
```
