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
// GFM tables: a header row, a |---|:--:| separator (alignment colons optional), then body rows.
// Runs after inline formatting (so cells hold bold/code/links) and before the paragraph splitter,
// which whitelists <table>. Operates on the already-esc()'d string - cell text is inserted verbatim
// (re-escaping would double-encode). Wrapping each table in blank lines makes it its own block. It
// degrades gracefully mid-stream: until the separator row streams in, the lines stay a plain paragraph.
function mdTables(h){
  const cells=r=>{let s=r.trim();if(s[0]==="|")s=s.slice(1);if(s[s.length-1]==="|")s=s.slice(0,-1);return s.split("|").map(c=>c.trim());};
  const isSep=r=>r.indexOf("|")>=0&&r.indexOf("-")>=0&&cells(r).every(c=>/^:?-+:?$/.test(c));
  const lines=h.split("\n"),out=[];
  for(let i=0;i<lines.length;i++){
    const head=lines[i],sep=lines[i+1];
    if(head.indexOf("|")>=0&&sep!=null&&isSep(sep)&&cells(head).length===cells(sep).length){
      const cols=cells(head),al=cells(sep).map(c=>{const l=c[0]===":",r=c[c.length-1]===":";return l&&r?"center":r?"right":l?"left":"";});
      const at=k=>al[k]?' style="text-align:'+al[k]+'"':"";
      let t="<table><thead><tr>"+cols.map((c,k)=>"<th"+at(k)+">"+c+"</th>").join("")+"</tr></thead>";
      const rows=[];let j=i+2;
      for(;j<lines.length;j++){if(lines[j].indexOf("|")<0||lines[j].trim()==="")break;rows.push(cells(lines[j]));}
      if(rows.length)t+="<tbody>"+rows.map(r=>"<tr>"+cols.map((_,k)=>"<td"+at(k)+">"+(r[k]==null?"":r[k])+"</td>").join("")+"</tr>").join("")+"</tbody>";
      out.push("\n"+t+"</table>\n");i=j-1;
    }else out.push(head);
  }
  return out.join("\n");
}
function md(src){src=String(src||"");const bl=[];src=src.replace(/```[a-z]*\n?([\s\S]*?)```/g,(m,c)=>{bl.push(c);return " "+(bl.length-1)+" ";});let h=esc(src);
  h=h.replace(/^####\s+(.+)$/gm,"<h4>$1</h4>").replace(/^###\s+(.+)$/gm,"<h3>$1</h3>").replace(/^##\s+(.+)$/gm,"<h2>$1</h2>").replace(/^#\s+(.+)$/gm,"<h1>$1</h1>");
  h=h.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g,"$1<em>$2</em>").replace(/`([^`]+)`/g,"<code>$1</code>").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(m,t,u)=>{const href=safeHref(u);return href==null?m:'<a href="'+href+'" target="_blank" rel="noopener">'+t+'</a>';});
  h=h.replace(/(?:^|\n)((?:\s*[-*] .+(?:\n|$))+)/g,(m,it)=>"\n<ul>"+it.trim().split("\n").map(l=>"<li>"+l.replace(/^\s*[-*]\s+/,"")+"</li>").join("")+"</ul>");
  h=h.replace(/(?:^|\n)((?:\s*\d+\. .+(?:\n|$))+)/g,(m,it)=>"\n<ol>"+it.trim().split("\n").map(l=>"<li>"+l.replace(/^\s*\d+\.\s+/,"")+"</li>").join("")+"</ol>");
  h=mdTables(h);
  h=h.split(/\n{2,}/).map(b=>{b=b.trim();if(!b)return"";if(/^<(h\d|ul|ol|pre|blockquote|table)/.test(b)||b.indexOf("")===0)return b;return"<p>"+b.replace(/\n/g,"<br>")+"</p>";}).join("\n");
  return h.replace(/(\d+)/g,(m,i)=>"<pre><code>"+esc(bl[i]).replace(/\n$/,"")+"</code></pre>");}
// Expose to the page's inline script and to tests. (Top-level consts are already visible to
// other classic scripts, but the test suite imports this file as a module, where only the
// globalThis assignments survive.)
globalThis.esc=esc;globalThis.escAttr=escAttr;globalThis.md=md;
