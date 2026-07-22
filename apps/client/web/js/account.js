"use strict";
// Standalone "connect an account" modal.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// The onboarding wizard connects an account on its final step; this is the SAME flow made reachable
// afterwards - opened from the title-bar sync dot when the workspace is still local (no account).
// Operator copy only: "Company URL", "Setup code", "Connect", "your company" - never push/commit/token.

/**
 * Open a modal to connect an account: a Company URL + Setup code, and a Connect button that POSTs
 * /api/account. On success the modal tears down and the sync surface refreshes (refreshProjects);
 * on a 4xx the server's message shows inline and the form stays up to retry.
 * @returns {void}
 */
function openConnectAccount() {
  const back = elt("div", "wz-backdrop"), card = elt("div", "wz-card");
  back.appendChild(card);
  document.body.appendChild(back);
  let error = "";
  const close = () => back.remove();
  const draw = () => {
    card.innerHTML =
      '<h2 class="wz-t">Connect your account</h2>' +
      '<div class="wz-body"><p>Save your work to your company. Paste the details your company gave you.</p>' +
      '<div class="wz-connect">' +
      '<label class="wz-field">Company URL<input id="wz-baseurl" type="text" inputmode="url" autocomplete="off" placeholder="https://sync.yourcompany.com"></label>' +
      '<label class="wz-field">Setup code<input id="wz-code" type="text" autocomplete="off" placeholder="Paste the code your company gave you"></label>' +
      (error ? '<div class="wz-err">' + esc(error) + '</div>' : '') +
      '<button class="wz-ghost" id="wz-connect" type="button">Connect</button>' +
      '</div></div>' +
      '<div class="wz-actions"><div class="wz-right"><button class="wz-ghost" data-a="cancel">Cancel</button></div></div>';
    card.querySelector('[data-a="cancel"]').onclick = close;
    card.querySelector("#wz-connect").onclick = async () => {
      const baseUrl = card.querySelector("#wz-baseurl").value.trim();
      const setupToken = card.querySelector("#wz-code").value.trim();
      const btn = card.querySelector("#wz-connect");
      btn.disabled = true; btn.textContent = "Connecting…";
      // postJSON never rejects on a non-2xx status (it just resolves with the parsed body) - it only
      // throws if fetch itself fails (offline, DNS, etc). So the catch below is for a genuinely
      // unreachable server; the 4xx/error case is read from `res.error` in the branch below, exactly
      // like onboarding.js's proven connect handler.
      let res;
      try { res = await postJSON("/api/account", { baseUrl, setupToken }); }
      catch (e) { res = { error: "Could not reach your company's server - check the URL and try again." }; }
      if (res && res.state === "connected") {
        close();
        if (typeof refreshProjects === "function") refreshProjects().catch(() => {});
      } else {
        btn.disabled = false; btn.textContent = "Connect";
        error = (res && res.error) || "Could not connect - check the URL and setup code.";
        draw();
      }
    };
  };
  draw();
}
