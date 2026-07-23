"use strict";
// OS notifications — telling the operator something needs them when they are not looking at BuildEx.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via <script src>,
// sharing one global scope. NOT an ES module.
//
// Deliberately the plain Web Notification API and nothing else. The console is a page on a loopback
// origin, whether it is displayed by the Electron window or by a browser tab, so `new Notification()`
// is the ONE mechanism that works on both: Electron turns it into a real native notification without
// a preload script, an IPC channel, or a second code path to keep in step.
//
// Two rules the rest of the app relies on:
//   * Nothing fires while BuildEx has focus. A notification for something already on screen trains
//     the operator to mute the app, and once muted the one that mattered is gone too.
//   * Nothing fires until the operator has said yes AND left the kind switched on. Permission is
//     asked from a button they pressed, never on load - a permission prompt nobody invited is the
//     fastest way to a permanent "Deny".

/** The kinds of notification, and what each one promises. Also the toggles in the settings dialog. */
const NOTIFY_KINDS = [
  { key: "loops", label: "A loop needs me, or failed", hint: "Not every run — only the ones that stopped for you." },
  { key: "chat", label: "The agent finished answering", hint: "Only when BuildEx is in the background." },
];

const NOTIFY_PREF_KEY = "buildex.notify";

/** Can this surface notify at all? False in a jsdom test, an old browser, or an insecure origin. */
function notifySupported() {
  return typeof Notification === "function";
}

/** "granted" | "denied" | "default" | "unsupported" — the OS's answer, not our preference. */
function notifyPermission() {
  return notifySupported() ? Notification.permission : "unsupported";
}

/** Per-kind preferences, defaulting ON: having granted permission, the operator asked for these. */
function notifyPrefs() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(NOTIFY_PREF_KEY) || "null");
  } catch (e) {
    /* a corrupt preference is just a default preference */
  }
  const out = {};
  for (const k of NOTIFY_KINDS) out[k.key] = !saved || saved[k.key] !== false;
  return out;
}

/** Switch one kind on or off on this machine. */
function setNotifyPref(kind, on) {
  const prefs = notifyPrefs();
  prefs[kind] = !!on;
  try {
    localStorage.setItem(NOTIFY_PREF_KEY, JSON.stringify(prefs));
  } catch (e) {
    /* a machine that won't persist the choice still honours it for this session */
  }
  return prefs;
}

/**
 * Ask the OS for permission. Called only from a button the operator pressed.
 * @returns {Promise<string>} the resulting permission state.
 */
async function enableNotifications() {
  if (!notifySupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch (e) {
    return notifyPermission();
  }
}

/** True while BuildEx is the window the operator is actually looking at. */
function appHasFocus() {
  return !document.hidden && (typeof document.hasFocus !== "function" || document.hasFocus());
}

/**
 * Tell the operator something, by whichever means fits where they are.
 *
 * @param {string} kind - a NOTIFY_KINDS key; an unswitched kind is silently dropped.
 * @param {{title:string, body?:string, tag?:string, onClick?:Function, whenFocused?:string}} o -
 *   `whenFocused` is "toast" to flash it in-app when BuildEx is already in front, or "skip"
 *   (the default) to say nothing, because the operator can already see it.
 * @returns {boolean} true if anything was shown.
 */
function notifyOperator(kind, o) {
  if (appHasFocus()) {
    if (o.whenFocused !== "toast") return false;
    toast(o.body ? o.title + " — " + o.body : o.title);
    return true;
  }
  if (!notifyPrefs()[kind]) return false;
  if (notifyPermission() !== "granted") return false;
  try {
    // `tag` collapses repeats: a loop that fails on every tick replaces its own notification instead
    // of stacking twenty of them in the operator's notification centre.
    const n = new Notification(o.title, { body: o.body || "", ...(o.tag ? { tag: o.tag } : {}) });
    n.onclick = () => {
      try {
        window.focus();
      } catch (e) {
        /* a browser may refuse to raise the window; the click still counts */
      }
      if (o.onClick) o.onClick();
      n.close();
    };
    return true;
  } catch (e) {
    return false; // never let a notification failure break the thing that triggered it
  }
}

/**
 * An inline row offering to turn notifications on, or null when there is nothing to offer — already
 * granted, refused at the OS level, or unsupported. Rendered where the operator would feel the lack
 * (the Loops panel), not as a banner on first paint.
 * @returns {HTMLElement|null}
 */
function notifyNudge() {
  if (notifyPermission() !== "default") return null;
  return el(
    "div",
    { class: "notifynudge" },
    el("span", { class: "nn-tx", text: "Get told when a loop needs you, even when BuildEx is behind something else." }),
    el("button", {
      class: "mini nn-on",
      text: "Turn on notifications",
      onClick: async (ev) => {
        const state = await enableNotifications();
        if (state === "granted") refreshLoops();
        else if (state === "denied") toast("Your system refused notifications for BuildEx. You can allow them in your OS settings.", true);
        else ev.currentTarget.blur();
      },
    }),
  );
}

/** Where notifications are configured: one dialog, reached from the profile menu. */
function openNotifySettings() {
  const bd = elt("div", "ovbackdrop");
  bd.appendChild(elt("div", "ovcard notifyset"));
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.onclick = (e) => {
    if (e.target === bd) close();
  };
  const paint = () => {
    const card = $(".notifyset", bd);
    card.innerHTML = "";
    card.append(...notifySettingsBody({ close, repaint: paint }));
  };
  paint();
}

/**
 * The dialog's body. Split from the opener so it renders into a test without an overlay.
 * @param {{close:Function, repaint:Function}} ctx
 * @returns {Array<Element>}
 */
function notifySettingsBody(ctx) {
  const state = notifyPermission();
  const prefs = notifyPrefs();
  const out = [el("h3", { class: "ovh", text: "Notifications" })];

  // The OS's answer comes first, because every toggle below is meaningless without it - and when it
  // is "denied" we say plainly that the fix is outside BuildEx rather than offering a dead button.
  const line = {
    granted: "BuildEx can notify you on this machine.",
    denied: "Your system is blocking notifications from BuildEx. Allow them in your OS settings, then reopen this.",
    default: "BuildEx has not asked your system yet.",
    unsupported: "This window cannot show system notifications.",
  }[state];
  out.push(
    el(
      "div",
      { class: "ns-state ns-" + state },
      el("span", { class: "ns-tx", text: line }),
      state === "default"
        ? el("button", {
            class: "mini ns-ask",
            text: "Turn on",
            onClick: async () => {
              await enableNotifications();
              ctx.repaint();
            },
          })
        : null,
    ),
  );

  out.push(
    el(
      "div",
      { class: "ns-kinds" },
      NOTIFY_KINDS.map((k) =>
        el(
          "label",
          { class: "ns-kind" + (state === "granted" ? "" : " off") },
          el("input", {
            type: "checkbox",
            class: "ns-cb",
            dataset: { kind: k.key },
            checked: prefs[k.key] || undefined,
            onChange: (ev) => setNotifyPref(k.key, ev.target.checked),
          }),
          el("span", { class: "ns-k" }, el("b", { text: k.label }), el("span", { class: "ns-hint", text: k.hint })),
        ),
      ),
    ),
  );

  out.push(el("div", { class: "ns-note", text: "Nothing is sent anywhere — these are your own machine's notifications, and BuildEx must be running to raise one." }));
  out.push(el("div", { class: "ovrow" }, el("button", { class: "mini ghost", text: "Done", onClick: ctx.close })));
  return out;
}
