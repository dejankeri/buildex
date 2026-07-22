"use strict";
// First-run "name your company" dialog — the front door to anonymous cloud backup.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Fired once on first run (see boot.js, which checks GET /api/onboarding's `firstRun` before
// calling openOnboard(), the same gate checkOnboarding() in onboarding.js uses for the wizard).
// Reads GET /api/sync for `signInAvailable` to decide whether to offer a cloud option at all: when
// sign-in is dormant (today's default - no Supabase config), the dialog never advertises a cloud
// backup that would only dead-end at /api/onboard's 501. Complements startSignIn() (signin.js),
// which is reached later, mid-session, by an operator who already has local work to back up; this
// dialog is the very first screen, before any work exists, and asks for the company name up front
// so /api/onboard can mint an anonymous account with no browser round-trip at all.
// Operator copy only: "Company name", "Back up to the cloud", "your company", "link Google later" -
// never push/commit/branch/merge/diff/token/JWT.

/**
 * Open the first-run "name your company" dialog. Reads GET /api/sync for `signInAvailable`:
 * - true: shows a Company name field plus a choice between "Back up to the cloud" (default,
 *   selected) and "Keep everything on this device", with honest copy about what each means.
 *   Submitting cloud with a non-empty name POSTs /api/onboard {companyName}; on
 *   {state:"connected"} the dialog tears down and refreshProjects() repaints the console. An
 *   empty name shows an inline message and never POSTs. Submitting local tears down without
 *   posting anything.
 * - false (today's default): no cloud option renders - a bare Company name + Continue proceeds
 *   local-only, never posting.
 * Either path marks onboarding complete via POST /api/onboarding/complete before tearing down, so
 * the dialog (and the wizard that gates on the same marker) never shows again.
 * @returns {Promise<void>}
 */
async function openOnboard() {
  if (document.querySelector(".onboard-modal")) return; // already open - don't stack a second
  let signInAvailable = false;
  try {
    const s = await getJSON("/api/sync");
    signInAvailable = !!(s && s.signInAvailable);
  } catch (e) {
    /* best-effort - treat as dormant, the safe default */
  }
  const back = elt("div", "wz-backdrop onboard-modal"), card = elt("div", "wz-card");
  back.appendChild(card);
  document.body.appendChild(back);
  let mode = "cloud"; // default selection when the cloud option is offered
  let error = "";
  const close = () => back.remove();
  const finish = () => {
    postJSON("/api/onboarding/complete", {}).catch(() => {});
    close();
  };
  const draw = () => {
    const nameInput = card.querySelector("#wz-company-name");
    const nameVal = nameInput ? nameInput.value : "";
    card.innerHTML =
      '<h2 class="wz-t">Name your company</h2>' +
      '<div class="wz-body">' +
      '<label class="wz-field">Company name<input id="wz-company-name" type="text" autocomplete="off" placeholder="Acme Co." value="' + escAttr(nameVal) + '"></label>' +
      (signInAvailable
        ? '<div class="wz-onboard-opts">' +
          '<label class="wz-onboard-opt' + (mode === "cloud" ? " on" : "") + '">' +
          '<input type="radio" name="wz-onboard-mode" value="cloud"' + (mode === "cloud" ? " checked" : "") + '>' +
          '<div><b>Back up to the cloud</b><p>Your work is saved to the cloud from the first second. You can link Google later so you never lose access and can invite your team.</p></div>' +
          "</label>" +
          '<label class="wz-onboard-opt' + (mode === "local" ? " on" : "") + '">' +
          '<input type="radio" name="wz-onboard-mode" value="local"' + (mode === "local" ? " checked" : "") + '>' +
          '<div><b>Keep everything on this device</b><p>Nothing leaves this machine - if you lose this device, you risk losing it.</p></div>' +
          "</label>" +
          "</div>"
        : "") +
      (error ? '<div class="wz-err">' + esc(error) + "</div>" : "") +
      "</div>" +
      '<div class="wz-actions"><div class="wz-right">' +
      '<button class="wz-primary" id="wz-onboard-continue" type="button">Continue</button>' +
      "</div></div>";
    if (signInAvailable) {
      card.querySelectorAll('input[name="wz-onboard-mode"]').forEach((r) => {
        r.onchange = () => {
          mode = r.value;
          draw();
        };
      });
    }
    card.querySelector("#wz-onboard-continue").onclick = async () => {
      // Local-only: never posts anything - just marks onboarding complete and proceeds.
      if (!signInAvailable || mode === "local") {
        finish();
        return;
      }
      // Cloud: requires a company name before /api/onboard can mint an anonymous account.
      const companyName = card.querySelector("#wz-company-name").value.trim();
      if (!companyName) {
        error = "Enter a company name to continue.";
        draw();
        return;
      }
      const btn = card.querySelector("#wz-onboard-continue");
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Setting up…";
      // postJSON never rejects on a non-2xx status (it just resolves with the parsed body) - it
      // only throws if fetch itself fails (offline, DNS, etc), mirrored from signin.js.
      let res;
      try {
        res = await postJSON("/api/onboard", { companyName });
      } catch (e) {
        res = { error: "Could not reach your company's server - check your connection and try again." };
      }
      if (res && res.state === "connected") {
        finish();
        if (typeof refreshProjects === "function") refreshProjects().catch(() => {});
      } else {
        btn.disabled = false;
        btn.textContent = label;
        if (res && res.state === "needs-help") {
          error = "Connected, but your account needs attention - please contact your company.";
        } else if (res && res.error === "sign-in not configured") {
          // The daemon's /api/onboard is dormant until the owner wires up Supabase - never surface
          // that raw internal string; fall back to the local-only path the operator can still use.
          error = "Cloud backup isn't available yet - continuing keeps your work on this device.";
        } else {
          error = (res && res.error) || "Could not set up your company - please try again.";
        }
        draw();
      }
    };
  };
  draw();
}
