"use strict";
// First-run welcome wizard.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// First-run welcome wizard. Shown once - GET /api/onboarding says whether it's a fresh
// install and whether the agent (Claude Code) is detected; finishing/skipping POSTs /complete so it
// never shows again. The agent step is skippable by design: the operator can explore the local
// workspace before connecting an agent.
// Reads no shared-global `S.*` fields.

/**
 * Show the first-run welcome wizard if this is a fresh install. Fetches /api/onboarding, builds a
 * modal card carousel (welcome → connect agent → integrations → done), and wires back/next/skip;
 * finishing or skipping past the last step POSTs /api/onboarding/complete. No-op (and silent) when
 * the fetch fails or it isn't a first run.
 * @returns {Promise<void>}
 */
async function checkOnboarding(){
  let o; try{o=await getJSON("/api/onboarding");}catch(e){return;}
  if(!o||!o.firstRun)return;
  // The "connect your agent" step's body depends on whether Claude Code was detected on the machine.
  const agentStep=(o.agent&&o.agent.available)
    ?'<div class="wz-ok">✓ Claude Code detected'+(o.agent.version?' · <span class="wz-mono">'+esc(o.agent.version)+'</span>':'')+'</div><p>BuildEx drives <b>your own</b> Claude Code. The driver seam is open - other agents welcome as contributions. It requires a Claude Pro subscription or higher. We never read your keys.</p>'
    :'<div class="wz-warn">Claude Code isn’t detected yet.</div><p>BuildEx runs your own agent CLI. The driver seam is open - other agents welcome as contributions. Install and sign in to Claude Code (requires Claude Pro) and it’s picked up automatically - or skip for now.</p>';
  // The wizard steps, in order. `skip:true` adds a "Skip" button alongside the primary CTA.
  const steps=[
    {t:"Welcome to BuildEx",body:"<p>Your company’s operating system - a coding agent, your files, and your team’s brain, all on your machine. Everything stays <b>local</b> until you choose to sync.</p>",cta:"Get started"},
    {t:"Connect your agent",body:agentStep,cta:"Continue",skip:true},
    {t:"Connect integrations",body:"<p>Later, connect Gmail, Calendar, Drive and more so your agent works with real company data. Install them any time from the <b>⊕ Store</b> in the left rail - no rush.</p>",cta:"Continue",skip:true},
    {t:"You’re all set",body:"<p>This is your <b>local</b> workspace - start chatting with your agent. Team sync accounts are coming - today everything stays on your machine.</p>",cta:"Start using BuildEx"},
  ];
  let i=0;
  const back=elt("div","wz-backdrop"), card=elt("div","wz-card"); back.appendChild(card); document.body.appendChild(back);
  // Mark onboarding complete (best-effort) and tear down the modal.
  const finish=()=>{postJSON("/api/onboarding/complete",{}).catch(()=>{});back.remove();};
  // Render the current step `i` into the card: progress dots, title, body, and back/skip/primary actions.
  const draw=()=>{
    const s=steps[i];
    card.innerHTML='<div class="wz-dots">'+steps.map((_,k)=>'<span class="'+(k===i?'on':'')+'"></span>').join('')+'</div>'+
      '<h2 class="wz-t">'+esc(s.t)+'</h2><div class="wz-body">'+s.body+'</div>'+
      '<div class="wz-actions">'+(i>0?'<button class="wz-ghost" data-a="back">Back</button>':'')+
      '<div class="wz-right">'+(s.skip?'<button class="wz-ghost" data-a="next">Skip</button>':'')+
      '<button class="wz-primary" data-a="next">'+esc(s.cta)+'</button></div></div>';
    card.querySelectorAll("[data-a]").forEach(b=>b.onclick=()=>{
      if(b.dataset.a==="back"){i=Math.max(0,i-1);draw();}
      else if(i>=steps.length-1)finish(); else{i++;draw();}
    });
  };
  draw();
}
