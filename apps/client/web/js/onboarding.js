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
  let o; try{o=await getJSON("/api/onboarding");}catch(e){maybeAutoTour();return;}
  // Not a fresh install: the wizard stays hidden, but new UI regions still deserve a one-time tour
  // (this also catches installs that predate the tour). maybeAutoTour no-ops if it's already been seen.
  if(!o||!o.firstRun){maybeAutoTour();return;}
  // The "connect your agent" step's body depends on whether Claude Code was detected on the machine.
  const agentStep=(o.agent&&o.agent.available)
    ?'<div class="wz-ok">✓ Claude Code detected'+(o.agent.version?' · <span class="wz-mono">'+esc(o.agent.version)+'</span>':'')+'</div><p>BuildEx drives <b>your own</b> Claude Code. The driver seam is open - other agents welcome as contributions. It requires a Claude Pro subscription or higher. We never read your keys.</p>'
    :'<div class="wz-warn">Claude Code isn’t detected yet.</div><p>BuildEx runs your own agent CLI. The driver seam is open - other agents welcome as contributions. Install and sign in to Claude Code (requires Claude Pro) and it’s picked up automatically - or skip for now.</p>';
  // The final step doubles as the account seam's connect affordance - best-effort read of the current
  // state; a fetch failure just leaves the operator with the connect form (the safe default: assume
  // not yet connected, never claim a connection we haven't confirmed).
  let acct; try{acct=await getJSON("/api/account");}catch(e){acct=null;}
  let connected=!!(acct&&acct.state==="connected");
  let acctError="";
  // Whether the build can actually sign in at all. Best-effort, and false on failure: never offer a
  // back-up button that would dead-end at a dormant /api/signin (501).
  let signInAvailable=false;
  try{const s=await getJSON("/api/sync");signInAvailable=!!(s&&s.signInAvailable);}catch(e){}
  // The final step is a real choice, not a form. There are exactly two end states - signed in with
  // Google, or fully local - and both are legitimate, so the step states them plainly and lets the
  // operator pick. Staying local needs no button: the step's own "Start using BuildEx" CTA is it.
  // Operator copy: "back up"/"save"/"your company", never push/commit/branch/merge/diff/token.
  const acctStepBody=()=>{
    if(connected)return'<p>This is your <b>local</b> workspace - start chatting with your agent. Your work is backed up'+(acct&&acct.companySlug?' to <b>'+esc(acct.companySlug)+'</b>':'')+'.</p>';
    if(!signInAvailable)return'<p>This is your <b>local</b> workspace - start chatting with your agent. Everything stays on this machine.</p>';
    return'<p>This is your <b>local</b> workspace - start chatting with your agent.</p>'+
      '<p>Back it up to your company so nothing is lost if this machine is - or keep everything on this device and decide later.</p>'+
      '<div class="wz-connect">'+
        '<button class="wz-primary wz-full" id="wz-signin-google" type="button">Back up - sign in with Google</button>'+
        (acctError?'<div class="wz-err">'+esc(acctError)+'</div>':'')+
      '</div>';
  };
  // The wizard steps, in order. `skip:true` adds a "Skip" button alongside the primary CTA. The last
  // step's `body` is a placeholder - draw() below replaces it with acctStepBody() so it stays live
  // across a Connect attempt (success/error) without touching the step's title or CTA.
  const steps=[
    {t:"Welcome to BuildEx",body:"<p>Your company’s operating system - a coding agent, your files, and your team’s brain, all on your machine. Everything stays <b>local</b> until you choose to sync.</p>",cta:"Get started"},
    {t:"Connect your agent",body:agentStep,cta:"Continue",skip:true},
    {t:"Connect integrations",body:"<p>Later, connect Gmail, Calendar, Drive and more so your agent works with real company data. Install them any time from the <b>⊕ Store</b> in the left rail - no rush.</p>",cta:"Continue",skip:true},
    {t:"You’re all set",body:"",cta:"Start using BuildEx"},
  ];
  let i=0;
  const back=elt("div","wz-backdrop"), card=elt("div","wz-card"); back.appendChild(card); document.body.appendChild(back);
  // Mark onboarding complete (best-effort), tear down the modal, then run the guided UI tour so a fresh
  // operator goes straight from "why" (the wizard) to "where" (the tour) without stacking the two.
  const finish=()=>{postJSON("/api/onboarding/complete",{}).catch(()=>{});back.remove();startTour(true);};
  // Render the current step `i` into the card: progress dots, title, body, and back/skip/primary actions.
  const draw=()=>{
    const s=steps[i];
    const last=(i===steps.length-1);
    const body=last?acctStepBody():s.body;
    // Exactly one primary per card. On the final step the recommended action is backing up, so the
    // Google button owns the emphasis and "Start using BuildEx" steps down to a ghost - it means
    // "skip this, stay local", which is a real choice but not the one to lead with. Two primaries
    // would leave the operator with no signal about which path is the recommended one.
    const ctaClass=(last&&!connected&&signInAvailable)?"wz-ghost":"wz-primary";
    card.innerHTML='<div class="wz-dots">'+steps.map((_,k)=>'<span class="'+(k===i?'on':'')+'"></span>').join('')+'</div>'+
      '<h2 class="wz-t">'+esc(s.t)+'</h2><div class="wz-body">'+body+'</div>'+
      '<div class="wz-actions">'+(i>0?'<button class="wz-ghost" data-a="back">Back</button>':'')+
      '<div class="wz-right">'+(s.skip?'<button class="wz-ghost" data-a="next">Skip</button>':'')+
      '<button class="'+ctaClass+'" data-a="next">'+esc(s.cta)+'</button></div></div>';
    card.querySelectorAll("[data-a]").forEach(b=>b.onclick=()=>{
      if(b.dataset.a==="back"){i=Math.max(0,i-1);draw();}
      else if(i>=steps.length-1)finish(); else{i++;draw();}
    });
    // Wire the back-up button (final step only, and only while signed out with sign-in wired). Same
    // POST /api/signin the sign-in modal uses - one auth path, no second implementation.
    const googleBtn=card.querySelector("#wz-signin-google");
    if(googleBtn)googleBtn.onclick=async()=>{
      // "Signing in…", not "Opening Google…": this one call covers BOTH legs - the browser round-trip
      // AND the backup that follows it (machine token, attaching each root, pushing them up). Google
      // is done within seconds; the rest is the long part, and naming the finished step while the
      // operator waits on the unfinished one reads as a hang.
      googleBtn.disabled=true;googleBtn.textContent="Signing in…";
      let res;
      try{res=await postJSON("/api/signin",{provider:"google"});}
      catch(e){res={error:"Could not reach your company's server - check your connection and try again."};}
      if(res&&res.state==="connected"){
        connected=true;acctError="";
        // POST /api/signin answers {state} and nothing else - the company name lives on
        // /api/account. Without this re-read the step degrades to an unnamed "Your work is backed
        // up.", which tells the operator less than it should at the one moment it matters.
        try{acct=await getJSON("/api/account");}catch(e){acct=res;}
        // Refresh the sync surface (the title-bar dot + save card) so it reflects the new
        // account immediately, without waiting for the next poll tick.
        if(typeof refreshProjects==="function")refreshProjects().catch(()=>{});
        draw();
      }else{
        googleBtn.disabled=false;googleBtn.textContent="Back up - sign in with Google";
        acctError=res&&res.state==="needs-help"
          ?"Signed in, but your account needs attention - please contact your company."
          :(res&&res.error)||"Could not sign in - please try again.";
        draw();
      }
    };
  };
  draw();
}
