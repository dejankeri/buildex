"use strict";
// Chat pane: composer, attach picker, session load, streamed agent turns.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Builds a chat tab's pane, loads its session history, and drives the SSE-streamed agent turns
// (thinking / tool / tool_result / text events) that POST /api/prompt returns.
// State it reads on the shared global `S`: `S.tree` (the cached workspace file tree, used to
// populate the attach picker; lazily loaded via loadTree()).

/**
 * Build the chat composer + thread into `tab.pane`: textarea, attach/model/effort controls, and
 * the Send button. Wires input auto-grow, Enter-to-send, and restores any prefill/model/effort.
 * @param {object} tab - the chat tab; `tab.pane` is mounted, `tab.thread` is set to the thread div.
 */
function buildChatPane(tab){
  tab.pane.classList.add("on");
  tab.pane.innerHTML='<div class="thread"></div><div class="composer">'
    +(tab.systemAppend?'<div class="ctxchip"></div>':'')
    +'<div class="box">'
    +'<textarea rows="1" aria-label="Message your company brain" placeholder="Ask your company brain…"></textarea>'
    +'<div class="crow">'
    +'<button class="ctool attach" title="Attach a workspace file" aria-label="Attach a workspace file">📎</button>'
    +'<select class="ctool modelsel" title="Model" aria-label="Model"><option value="sonnet">Sonnet 5</option><option value="opus">Opus 4.8</option><option value="haiku">Haiku 4.5</option><option value="fable">Fable 5</option></select>'
    +'<select class="ctool effortsel" title="Thinking effort" aria-label="Thinking effort"><option value="">Effort: normal</option><option value="think">Think</option><option value="think-harder">Think harder</option></select>'
    +'<span class="cspacer"></span><button class="send">Send</button></div>'
    +'</div></div>';
  tab.thread=$(".thread",tab.pane);
  const ta=$("textarea",tab.pane), send=$(".send",tab.pane);
  const model=$(".modelsel",tab.pane), effort=$(".effortsel",tab.pane), attach=$(".attach",tab.pane);
  model.value=tab.model||"sonnet"; // Sonnet 5 is the pinned default (see wiring defaultModel)
  effort.value=tab.effort||"";
  // Persist the picker selections back onto the tab; empty string means "default" (null).
  model.onchange=()=>tab.model=model.value||null;
  effort.onchange=()=>tab.effort=effort.value||null;
  attach.onclick=()=>openAttachPicker(tab,ta);
  // Auto-grow the textarea up to 200px, then let it scroll.
  const grow=()=>{ta.style.height="auto";ta.style.height=Math.min(ta.scrollHeight,200)+"px";};
  // Send the trimmed prompt (unless empty or a turn is already running), then reset the box.
  const go=()=>{const p=ta.value.trim();if(p&&!tab.busy){ta.value="";grow();sendPrompt(tab,p);}};
  send.onclick=go;
  ta.addEventListener("input",grow);
  ta.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();go();}}; // Enter sends, Shift+Enter newlines
  // Optional prefill (e.g. the "Run skill" action): fill, focus, caret to end, grow.
  if(tab.prefill){ta.value=tab.prefill;setTimeout(()=>{ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length);grow();},0);}
  // Discrete context chip (e.g. opened from an app): shows the injected orienting context - the
  // composer stays empty, the context rides along invisibly as a system append on each turn.
  if(tab.systemAppend)renderCtxChip(tab);
}

/**
 * Render the app-context chip above the composer. It shows which app the chat is oriented to, offers
 * a Connect action when the app's tools aren't authorized yet, and an × that removes the injected
 * context (clears tab.systemAppend so later turns carry no app append).
 * @param {object} tab - the chat tab holding `systemAppend` (+ optional `app`/`appConn`).
 */
function renderCtxChip(tab){
  const chip=$(".ctxchip",tab.pane);if(!chip)return;
  const needsAuth=!!(tab.appConn&&tab.appConn.needsAuth);
  const title=(tab.app&&tab.app.title)||"this app";
  chip.className="ctxchip"+(needsAuth?" warn":"");
  chip.innerHTML='<span class="cx-ic">'+(needsAuth?"⚠":"✦")+'</span>'
    +'<span class="cx-tx">'+(needsAuth
        ?'<b>'+esc(title)+'</b> tools aren’t connected yet'
        :'Working with <b>'+esc(title)+'</b> · tools &amp; skills loaded')+'</span>'
    +(needsAuth?'<button class="cx-connect">Connect</button>':'')
    +'<button class="cx-x" title="Remove this context" aria-label="Remove context">×</button>';
  const con=$(".cx-connect",chip);
  if(con&&typeof connectApp==="function")con.onclick=()=>connectApp(tab.app,tab.appConn);
  $(".cx-x",chip).onclick=()=>{tab.systemAppend=null;chip.remove();};
}

/**
 * Flatten a nested file tree into a flat list of file paths (depth-first), accumulating into `out`.
 * @param {Array} nodes - tree nodes; each is a file (has `path`) or a dir (has `children`).
 * @param {string[]} out - accumulator, returned.
 * @returns {string[]} `out` with every descendant file path appended.
 */
function flattenTree(nodes,out){(nodes||[]).forEach(n=>{if(n.type==="file")out.push(n.path);else if(n.children)flattenTree(n.children,out);});return out;}

/**
 * Insert `text` at the textarea's caret (replacing any selection), then fire an input event so the
 * auto-grow handler runs.
 * @param {HTMLTextAreaElement} ta - target textarea.
 * @param {string} text - text to splice in at the selection.
 */
function insertAt(ta,text){const s=ta.selectionStart!=null?ta.selectionStart:ta.value.length;const e=ta.selectionEnd!=null?ta.selectionEnd:s;ta.value=ta.value.slice(0,s)+text+ta.value.slice(e);ta.selectionStart=ta.selectionEnd=s+text.length;ta.dispatchEvent(new Event("input"));}

/**
 * Open the attach-file dropdown under the composer: a filter box over the workspace's files;
 * picking one inserts `@path ` at the caret. Loads the file tree on first use.
 * @param {object} tab - the chat tab whose composer hosts the menu.
 * @param {HTMLTextAreaElement} ta - the composer textarea to insert the chosen path into.
 */
async function openAttachPicker(tab,ta){
  closeMenus();
  if(!(S.tree&&S.tree.length))await loadTree();
  const files=flattenTree(S.tree,[]);
  const host=$(".composer",tab.pane);
  const m=elt("div","dropdown attachmenu");
  m.innerHTML='<input class="afind" placeholder="Attach a file - inserts @path"><div class="alist"></div>';
  const list=$(".alist",m),inp=$(".afind",m);
  // Redraw the list filtered by `f` (a lowercased substring); cap at 60 rows.
  const draw=f=>{list.innerHTML="";const shown=files.filter(p=>!f||p.toLowerCase().includes(f)).slice(0,60);if(!shown.length){list.innerHTML='<div class="amini">No files.</div>';}shown.forEach(p=>{const b=elt("button",null,esc(p));b.onclick=()=>{insertAt(ta,"@"+p+" ");closeMenus();ta.focus();};list.appendChild(b);});};
  inp.oninput=()=>draw(inp.value.toLowerCase().trim());
  draw("");
  host.appendChild(m);
  m.dataset.menu="1";
  setTimeout(()=>inp.focus(),0);
}

/**
 * Fetch a session's stored events and replay them into the tab's thread; shows an empty-state
 * prompt when the session has no events. Network/parse errors are swallowed (blank thread).
 * @param {object} tab - the chat tab; `tab.sessionId` selects the session, `tab.thread` receives it.
 */
async function loadSession(tab){
  try{const s=await getJSON("/api/sessions/"+tab.sessionId);
    if(!s.events||!s.events.length){tab.thread.appendChild(elt("div","empty",'<div class="big">◈</div>Ask about your brain - try "Summarize our Q3 metrics and charter."'));return;}
    renderHistory(tab,s.events);
  }catch(e){}
}

/**
 * Replay a session's event list into the thread, reconstructing operator messages and agent turns.
 * @param {object} tab - the chat tab receiving the rendered turns.
 * @param {Array} events - stored events (`text` / `thinking` / `tool` / `tool_result` / `done`).
 */
function renderHistory(tab,events){
  // Replay using `done` as the turn boundary: after a done (or at the start) the next text is the
  // operator's message; everything until the next done belongs to one agent turn.
  let turn=null, afterDone=true;
  events.forEach(e=>{
    if(e.kind==="done"){if(turn)turn.done();turn=null;afterDone=true;return;}
    if(afterDone&&e.kind==="text"){const u=elt("div","turn");u.innerHTML='<div class="who"><span class="av op">You</span><span class="nm">You</span></div><div class="bubble op">'+esc(e.text)+'</div>';tab.thread.appendChild(u);afterDone=false;return;}
    if(!turn)turn=agentTurn(tab);
    if(e.kind==="thinking")turn.think(e.text);
    else if(e.kind==="tool")turn.tool(e);
    else if(e.kind==="tool_result")turn.toolDone(e);
    else if(e.kind==="text")turn.addText(e.text);
  });
  if(turn)turn.done(); // the trailing turn may have no `done` event yet - finalize it anyway
}

/**
 * Mount an agent turn into the thread and return a controller for streaming its parts.
 * The turn is a collapsible "working" trace (thinking + tool steps) above an always-visible answer
 * body. Narration text emitted before/between tool calls is folded into the trace; only the final
 * text run (after the last tool) stays as the answer.
 * @param {object} tab - the chat tab whose thread receives the turn.
 * @returns {{think:Function, tool:Function, toolDone:Function, setText:Function, addText:Function, done:Function}}
 *   controller: `think`/`tool`/`toolDone` feed the trace, `setText`/`addText` set the answer,
 *   `done` freezes the summary once the stream ends.
 */
function agentTurn(tab){
  const w=elt("div","turn");w.innerHTML='<div class="who"><span class="av ag">✦</span><span class="nm">Agent</span></div>';
  // One collapsible "working" trace (thinking + tool steps), collapsed by default. The answer text
  // below it is always visible. Expand to see how the agent got there - the Claude Code pattern.
  const work=elt("details","work");work.style.display="none";
  work.innerHTML='<summary><span class="wk-label">Working…</span><span class="wk-latest"></span></summary><div class="wk-body"><div class="wk-think"></div><div class="wk-steps" style="display:flex;flex-direction:column;gap:7px;"></div></div>';
  const body=elt("div","md"); w.append(work,body); tab.thread.appendChild(w);
  const label=$(".wk-label",work),latest=$(".wk-latest",work),thinkEl=$(".wk-think",work),steps=$(".wk-steps",work);
  let cur="",n=0,shown=false,finished=false;
  // Reveal the trace the first time there's anything to show.
  const show=()=>{if(!shown){shown=true;work.style.display="";}};
  // Update the "· latest activity" tail in the summary (until the turn is finished/frozen).
  const tip=s=>{if(!finished)latest.textContent=" · "+s;};
  // Text the agent emits BEFORE/BETWEEN tool calls is narration ("Let me read the metrics…"), not the
  // answer. When a tool arrives, fold the current text run into the trace and clear the answer body -
  // so only the final run (after the last tool) remains as the answer. The Claude Code pattern.
  const flush=()=>{if(cur.trim()){show();steps.appendChild(elt("div","wk-note",esc(cur.trim())));}cur="";body.innerHTML="";};
  return {
    think:t=>{show();thinkEl.textContent=t;tip("thinking");},
    tool:e=>{flush();show();n++;steps.appendChild(elt("div","tool",'<span class="tk">'+esc(e.name)+'</span>'+(e.path?'<span class="path">'+esc(e.path)+'</span>':"")+'<span class="st2" data-id="'+escAttr(e.id)+'"></span>'));tip(e.name+(e.path?" "+String(e.path).split("/").pop():""));},
    toolDone:e=>{const s=steps.querySelector('.st2[data-id="'+String(e.id||"").replace(/"/g,"")+'"]');if(s)s.textContent=e.ok?"✓":"✕";},
    setText:t=>{cur=t;body.innerHTML=md(cur);},
    addText:t=>{cur+=t;body.innerHTML=md(cur);},
    // Called once the turn's stream ends (the caller knows the boundary). Freezes the summary to the
    // final step count - the agent emits text before AND after tool calls, so we can't finalize on text.
    done:()=>{if(shown&&!finished){finished=true;label.textContent="Worked";latest.textContent=" · "+n+" step"+(n===1?"":"s");}}
  };
}

/**
 * Send `prompt` for `tab`: append the operator bubble, open an agent turn, POST /api/prompt, and
 * stream the response — parsing the SSE-style body (double-newline-delimited JSON frames) into
 * think/tool/tool_result/text/error calls on the turn. Manages busy/sync state and sets the tab
 * title from the first prompt.
 * @param {object} tab - the chat tab sending the prompt.
 * @param {string} prompt - the operator's message text.
 */
async function sendPrompt(tab,prompt){
  tab.busy=true;tab.status="running";renderTabbar();syncBusy++;setSync("busy");
  if(tab.thread.querySelector(".empty"))tab.thread.innerHTML="";
  const u=elt("div","turn");u.innerHTML='<div class="who"><span class="av op">You</span><span class="nm">You</span></div><div class="bubble op">'+esc(prompt)+'</div>';tab.thread.appendChild(u);
  const turn=agentTurn(tab);const sc=()=>tab.thread.scrollTop=tab.thread.scrollHeight;sc();
  let text="",think="";
  try{
    const res=await fetch("/api/prompt",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt,sessionId:tab.sessionId,...(tab.model?{model:tab.model}:{}),...(tab.effort?{effort:tab.effort}:{}),...(tab.systemAppend?{systemPromptAppend:tab.systemAppend}:{})})});
    // Stream the response body: decode chunks, split on blank lines into frames, JSON-parse the
    // object starting at the first "{" in each frame. `buf` holds the trailing partial frame.
    const rd=res.body.getReader(),dec=new TextDecoder();let buf="";
    while(true){const c=await rd.read();if(c.done)break;buf+=dec.decode(c.value,{stream:true});const ps=buf.split("\n\n");buf=ps.pop();
      for(const p of ps){const i=p.indexOf("{");if(i<0)continue;let e;try{e=JSON.parse(p.slice(i));}catch(x){continue;}
        if(e.kind==="thinking"){think+=e.text;turn.think(think);}else if(e.kind==="tool")turn.tool(e);else if(e.kind==="tool_result")turn.toolDone(e);else if(e.kind==="text"){text+=e.text;turn.addText(e.text);}else if(e.kind==="error")turn.setText("**Error:** "+e.message);sc();}}
    if(!text&&!think)turn.setText("_(no response)_");
  }catch(e){turn.setText("**Error:** "+(e&&e.message||e));}
  turn.done(); // stream closed - freeze the working-trace summary to its final step count
  syncBusy=Math.max(0,syncBusy-1);if(!syncBusy)setSync("ok");
  tab.busy=false;tab.status="idle";renderTabbar();
  // set a title from first user prompt
  if(tab.title==="New chat"){tab.title=prompt.slice(0,32);renderTabbar();}
  refreshPending();refreshProjects();
}
