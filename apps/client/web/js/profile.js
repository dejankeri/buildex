"use strict";
// Profile menu — the title-bar account home (sign in / your company / log out).
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Opened from the title-bar #profileBtn (boot.js). Reads GET /api/account (state:"local"|"connected",
// companySlug) and GET /api/sync (signInAvailable) to decide what to offer:
// - signed out: the SAME entry points as the left-rail pill / pending card (projects.js, pending.js)
//   - "Sign in" runs startSignIn() when signInAvailable, else falls back to openConnectAccount()
//   (mirrors renderSigninPill's gating) - plus a secondary "Have a setup code?" straight to
//   openConnectAccount(), exactly like signin.js's own disclosure.
// - connected: the company line ("Connected to <companySlug>") and "Log out", which opens a
//   confirm step before POSTing /api/logout - the reverse of openConnectAccount()'s connect
//   (Task 2's runDisconnect on the daemon side).
// Operator copy only: "Sign in", "Log out", "your company", "your work stays on this machine",
// "Have a setup code?" - never push/commit/branch/merge/diff/token/JWT.

/**
 * Open a confirm step for logging out, mirroring the postJSON idiom in signin.js/account.js: the
 * dialog stays up and shows the server's message inline on an error, and only tears down on
 * {state:"local"}, at which point refreshProjects() repaints the console back to signed-out.
 * @param {string} [companySlug] - the connected company, for the confirm copy.
 * @returns {void}
 */
function openLogoutConfirm(companySlug) {
  if (document.querySelector(".logout-modal")) return; // already open - don't stack a second
  const back = elt("div", "wz-backdrop logout-modal"), card = elt("div", "wz-card");
  back.appendChild(card);
  document.body.appendChild(back);
  const company = companySlug || "your company";
  let error = "";
  const close = () => back.remove();
  const draw = () => {
    card.innerHTML =
      '<h2 class="wz-t">Log out?</h2>' +
      '<div class="wz-body"><p>Log out disconnects this device from ' + esc(company) + ". Your work stays on this machine. " +
      "If you signed in anonymously, you may not be able to get back in unless you've linked Google.</p>" +
      (error ? '<div class="wz-err">' + esc(error) + "</div>" : "") +
      "</div>" +
      '<div class="wz-actions"><div class="wz-right"><button class="wz-ghost" data-a="cancel">Cancel</button>' +
      '<button class="wz-primary" id="wz-logout-confirm" type="button">Log out</button></div></div>';
    card.querySelector('[data-a="cancel"]').onclick = close;
    // postJSON never rejects on a non-2xx status (it just resolves with the parsed body) - it only
    // throws if fetch itself fails (offline, DNS, etc). So the catch below is for a genuinely
    // unreachable server; the 4xx/error case is read from `res.error` in the branch below, exactly
    // like signin.js/account.js's proven handlers.
    card.querySelector("#wz-logout-confirm").onclick = async () => {
      const btn = card.querySelector("#wz-logout-confirm");
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = "Logging out…";
      let res;
      try { res = await postJSON("/api/logout", {}); }
      catch (e) { res = { error: "Could not log out - please try again." }; }
      if (res && res.state === "local") {
        close();
        if (typeof refreshProjects === "function") refreshProjects().catch(() => {});
      } else {
        btn.disabled = false; btn.textContent = label;
        error = (res && res.error) || "Could not log out - please try again.";
        draw();
      }
    };
  };
  draw();
}

/**
 * Open the profile menu anchored to #profileBtn. Fetches /api/account + /api/sync (best-effort -
 * a failed fetch is treated as signed-out/dormant, the same safe default openOnboard() uses) and
 * draws a small dropdown:
 * - signed out ("local"): "Sign in" + "Have a setup code?", no company line, no Log out.
 * - connected: "Connected to <companySlug>" + "Log out" - NOT the sign-in actions.
 * @returns {Promise<void>}
 */
async function openProfile() {
  closeMenus();
  const anchor = $("#profileBtn");
  let account = { state: "local" };
  let signInAvailable = false;
  try {
    const [a, s] = await Promise.all([getJSON("/api/account"), getJSON("/api/sync")]);
    if (a) account = a;
    signInAvailable = !!(s && s.signInAvailable);
  } catch (e) {
    /* best-effort - treat as signed-out/dormant, the safe default */
  }
  if (document.querySelector(".profile-menu")) return; // a repeat call raced in while we awaited - don't stack a second
  const m = elt("div", "dropdown profile-menu");
  if (account.state === "connected") {
    m.appendChild(elt("div", "mhd", "Connected to " + esc(account.companySlug || "your company")));
    const out = elt("button", null, "Log out");
    out.onclick = () => {
      closeMenus();
      openLogoutConfirm(account.companySlug);
    };
    m.appendChild(out);
  } else {
    const signIn = elt("button", null, "Sign in");
    signIn.onclick = () => {
      closeMenus();
      if (signInAvailable) startSignIn();
      else openConnectAccount();
    };
    m.appendChild(signIn);
    const code = elt("button", null, "Have a setup code?");
    code.onclick = () => {
      closeMenus();
      openConnectAccount();
    };
    m.appendChild(code);
  }
  document.body.appendChild(m);
  m.dataset.menu = "1";
  const r = anchor.getBoundingClientRect();
  m.style.position = "fixed";
  m.style.top = (r.bottom + 4) + "px";
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
}
