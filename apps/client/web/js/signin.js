"use strict";
// Sign-in modal — the front door to backing up local work to the operator's company.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Reached from the left-rail "Back up & sync" pill (projects.js) and the pending tray's save card
// (pending.js), both shown only while the workspace has no connected account. Complements
// openConnectAccount() (account.js), which asks for a Company URL + Setup code straight away -
// right for an operator who already has those details (e.g. from an invite). This modal leads with
// Sign in with Google (no setup code needed at all), offers an email link as a fallback, and tucks
// the setup-code flow behind a "Have a setup code?" disclosure that hands off to
// openConnectAccount() unchanged.
// Operator copy only: "Sign in", "back up & sync", "your company" - never push/commit/branch/merge/diff/token/JWT.

/**
 * Open the sign-in modal. Two primary actions - "Sign in with Google" and "Email me a link" - each
 * POST /api/signin; on {state:"connected"} the modal tears down and refreshProjects() repaints the
 * console. A returned error shows inline and the form stays up to retry. A secondary "Have a setup
 * code?" link steps aside entirely into the existing connect-an-account flow.
 * @returns {void}
 */
function startSignIn() {
  if (document.querySelector(".signin-modal")) return; // already open - don't stack a second
  const back = elt("div", "wz-backdrop signin-modal"), card = elt("div", "wz-card");
  back.appendChild(card);
  document.body.appendChild(back);
  let error = "";
  const close = () => back.remove();
  const draw = () => {
    card.innerHTML =
      '<h2 class="wz-t">Sign in</h2>' +
      '<div class="wz-body"><p>Back up your work to your company, free.</p>' +
      '<div class="wz-connect">' +
      '<button class="wz-primary wz-full" id="wz-signin-google" type="button">Sign in with Google</button>' +
      '<div class="wz-or"><span>or</span></div>' +
      '<label class="wz-field">Email<input id="wz-signin-email" type="email" autocomplete="off" placeholder="you@yourcompany.com"></label>' +
      '<button class="wz-ghost wz-full" id="wz-signin-emailgo" type="button">Email me a link</button>' +
      (error ? '<div class="wz-err">' + esc(error) + '</div>' : '') +
      '</div>' +
      '<button class="wz-link" id="wz-signin-code" type="button">Have a setup code?</button>' +
      '</div>' +
      '<div class="wz-actions"><div class="wz-right"><button class="wz-ghost" data-a="cancel">Cancel</button></div></div>';
    card.querySelector('[data-a="cancel"]').onclick = close;
    // The setup-code path is a different, already-shipped flow (account.js) - hand off to it
    // entirely rather than reimplementing base-URL + setup-code fields here.
    card.querySelector("#wz-signin-code").onclick = () => {
      close();
      openConnectAccount();
    };
    // postJSON never rejects on a non-2xx status (it just resolves with the parsed body) - it only
    // throws if fetch itself fails (offline, DNS, etc). So the catch below is for a genuinely
    // unreachable server; the 4xx/error case is read from `res.error` in the branch below, exactly
    // like openConnectAccount()'s proven connect handler in account.js.
    const signIn = async (body, btn, busyLabel) => {
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = busyLabel;
      let res;
      try { res = await postJSON("/api/signin", body); }
      catch (e) { res = { error: "Could not reach your company's server - check your connection and try again." }; }
      if (res && res.state === "connected") {
        close();
        if (typeof refreshProjects === "function") refreshProjects().catch(() => {});
      } else {
        btn.disabled = false; btn.textContent = label;
        error = (res && res.error) || "Could not sign in - please try again.";
        draw();
      }
    };
    card.querySelector("#wz-signin-google").onclick = () =>
      signIn({ provider: "google" }, card.querySelector("#wz-signin-google"), "Opening Google…");
    card.querySelector("#wz-signin-emailgo").onclick = () => {
      const emailInput = card.querySelector("#wz-signin-email");
      const email = emailInput.value.trim();
      if (!email) { emailInput.focus(); return; } // nothing to send yet - stay put, don't POST
      signIn({ email }, card.querySelector("#wz-signin-emailgo"), "Sending…");
    };
  };
  draw();
}
