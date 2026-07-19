// Markdown renderer + HTML escapers for the operator console (web/index.html).
// Extracted from the page's inline script so the vitest suite can pin its behavior - the
// stored-XSS fix on link targets lives here. This file must stay a *classic*
// script (no import/export): index.html loads it via <script src="md.js"> ahead of its inline
// script, and src/md.test.ts side-effect-imports it and reads the globals. The real module
// split is item C1.
// NOTE: md() stashes fenced code blocks behind invisible 0x01 (SOH) sentinel bytes so inline
// formatting can't touch them - they look like stray spaces in an editor. Don't "fix" them.
"use strict";
const esc=s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const escAttr=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
// A markdown link target lands inside href="…", so two rules keep hostile input inert: the
// scheme must be allowlisted (https/http/mailto - javascript:, data:, etc. return null and the
// caller renders the raw markdown as plain text instead of a link), and quotes are escaped so
// the URL can't close the attribute. The input has already been through esc() (& < > are
// entities), so only the quotes are escaped here - a full escAttr() pass would double-encode &.
// Allow absolute web/mail links, OR a strictly path-like relative link (the brain's own
// cross-references, e.g. `model.md` / `../decisions/log.md`). The relative branch is a tight
// allowlist: no leading `/` or `\` (blocks protocol-relative `//host` and the `\\host` form browsers
// normalize to it), and only path characters — so any explicit scheme (javascript:, data:, file:)
// or host-bearing value is refused → the raw markdown renders as plain text.
const safeHref=u=>{u=String(u==null?"":u);const ok=/^(?:https?|mailto):/i.test(u)||/^(?![/\\])[A-Za-z0-9_./-]+$/.test(u);return ok?u.replace(/"/g,"&quot;").replace(/'/g,"&#39;"):null;};
function md(src){src=String(src||"");const bl=[];src=src.replace(/```[a-z]*\n?([\s\S]*?)```/g,(m,c)=>{bl.push(c);return " "+(bl.length-1)+" ";});let h=esc(src);
  h=h.replace(/^####\s+(.+)$/gm,"<h4>$1</h4>").replace(/^###\s+(.+)$/gm,"<h3>$1</h3>").replace(/^##\s+(.+)$/gm,"<h2>$1</h2>").replace(/^#\s+(.+)$/gm,"<h1>$1</h1>");
  h=h.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g,"$1<em>$2</em>").replace(/`([^`]+)`/g,"<code>$1</code>").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(m,t,u)=>{const href=safeHref(u);return href==null?m:'<a href="'+href+'" target="_blank" rel="noopener">'+t+'</a>';});
  h=h.replace(/(?:^|\n)((?:\s*[-*] .+(?:\n|$))+)/g,(m,it)=>"\n<ul>"+it.trim().split("\n").map(l=>"<li>"+l.replace(/^\s*[-*]\s+/,"")+"</li>").join("")+"</ul>");
  h=h.replace(/(?:^|\n)((?:\s*\d+\. .+(?:\n|$))+)/g,(m,it)=>"\n<ol>"+it.trim().split("\n").map(l=>"<li>"+l.replace(/^\s*\d+\.\s+/,"")+"</li>").join("")+"</ol>");
  h=h.split(/\n{2,}/).map(b=>{b=b.trim();if(!b)return"";if(/^<(h\d|ul|ol|pre|blockquote)/.test(b)||b.indexOf("")===0)return b;return"<p>"+b.replace(/\n/g,"<br>")+"</p>";}).join("\n");
  return h.replace(/(\d+)/g,(m,i)=>"<pre><code>"+esc(bl[i]).replace(/\n$/,"")+"</code></pre>");}
// Expose to the page's inline script and to tests. (Top-level consts are already visible to
// other classic scripts, but the test suite imports this file as a module, where only the
// globalThis assignments survive.)
globalThis.esc=esc;globalThis.escAttr=escAttr;globalThis.md=md;
