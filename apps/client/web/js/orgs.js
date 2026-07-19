"use strict";
// Organization switcher (B2a) — the row at the top of the left rail. Lists the operator's
// organizations, switches the active one, and creates a new real org. One org is the DEMO SANDBOX
// (Acme Labs): local-only and never synced, clearly badged so it's never mistaken for a real company.
//
// Switching or creating rebuilds the daemon handler for the target org (rebuild-on-switch), so the
// console reloads to pick up the new org's sessions/brain/apps — a clean, whole-page context change.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via <script src>,
// sharing one global scope. NOT an ES module. Renders through the safe DOM builder
// (dom.js `el`/`txt`), so an org's user-supplied name can never be parsed as markup.

/**
 * Fetch the org list and render the switcher. On a single-workspace daemon `/api/orgs` is absent, so
 * a failure just hides the switcher — the rest of the console is unaffected.
 * @returns {Promise<void>}
 */
async function refreshOrgs() {
  let data;
  try {
    data = await getJSON("/api/orgs");
  } catch {
    document.getElementById("orgbar")?.setAttribute("hidden", "");
    return;
  }
  renderOrgSwitcher(data);
}

/**
 * Render the switcher into #orgbar from `{ orgs, activeId }`. Pure DOM, no network — the boot/refresh
 * path calls it after a fetch; tests call it directly.
 * @param {{orgs: {id:string,name:string,sandbox:boolean}[], activeId:string}} data
 */
function renderOrgSwitcher(data) {
  const bar = document.getElementById("orgbar");
  if (!bar) return;
  const orgs = (data && data.orgs) || [];
  if (!orgs.length) {
    bar.setAttribute("hidden", "");
    return;
  }
  bar.removeAttribute("hidden");
  bar.textContent = ""; // clear safely
  const active = orgs.find((o) => o.id === data.activeId) || orgs[0];
  // Reflect the sandbox on <body> so CSS can suppress the sync affordance for a non-syncable org.
  document.body.classList.toggle("sandbox", !!active.sandbox);

  const menu = el(
    "div",
    { class: "orgmenu", id: "orgmenu", hidden: "" },
    ...orgs.map((o) =>
      el(
        "button",
        { class: "orgitem" + (o.id === active.id ? " on" : ""), type: "button", dataset: { id: o.id }, onClick: () => switchOrg(o.id) },
        el("span", { class: "orgname", text: o.name }),
        o.sandbox && el("span", { class: "orgtag", text: "Demo · local" }),
        o.id === active.id && el("span", { class: "orgcheck", text: "✓" }),
      ),
    ),
    el("div", { class: "orgsep" }),
    orgCreateRow(),
  );

  const current = el(
    "button",
    { class: "orgcurrent", type: "button", title: "Switch organization", "aria-haspopup": "true", "aria-expanded": "false", onClick: () => toggleOrgMenu() },
    el("span", { class: "orgdot" }),
    el("span", { class: "orgname", text: active.name }),
    active.sandbox && el("span", { class: "orgtag", text: "Demo" }),
    el("span", { class: "orgcaret", text: "▾" }),
  );

  bar.append(current, menu);
  if (active.sandbox) bar.append(el("div", { class: "orgnote", text: "Sandbox · local only · never synced" }));
}

/** The "start my company" row — an inline input + button (no browser prompt() dialog). */
function orgCreateRow() {
  const input = el("input", { class: "orgnew", type: "text", placeholder: "New organization name", "aria-label": "New organization name" });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createOrg(input.value);
  });
  return el("div", { class: "orgcreate" }, input, el("button", { class: "orgcreatebtn", type: "button", text: "Start my company", onClick: () => createOrg(input.value) }));
}

/** Toggle the org dropdown open/closed. */
function toggleOrgMenu() {
  const m = document.getElementById("orgmenu");
  if (!m) return;
  const opening = m.hasAttribute("hidden");
  if (opening) m.removeAttribute("hidden");
  else m.setAttribute("hidden", "");
  document.querySelector(".orgcurrent")?.setAttribute("aria-expanded", String(opening));
}

/** Switch to an existing org, then reload so the console reflects it. */
async function switchOrg(id) {
  try {
    await postJSON("/api/orgs/switch", { id });
    location.reload();
  } catch {
    /* stay put on failure */
  }
}

/** Create a real local org and switch into it. Empty names are ignored. */
async function createOrg(name) {
  name = (name || "").trim();
  if (!name) return;
  try {
    await postJSON("/api/orgs/create", { name });
    location.reload();
  } catch {
    /* stay put on failure */
  }
}
