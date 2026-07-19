"use strict";
// In-app browser pane.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Builds a minimal browser surface inside a tab — nav bar + address input + a <webview> (desktop)
// or sandboxed <iframe> (plain-browser demo). Reads/writes no shared `S` state.

/**
 * Build the browser pane UI into `tab.pane` and wire its address bar / nav buttons.
 * @param {object} tab - the browser tab; `tab.url` seeds the initial address, `tab.title` tracks it.
 */
function buildBrowserPane(tab) {
  tab.pane.className = "pane brow on";
  // In the desktop app a <webview> is a real browsing context - it loads any site (google.com etc.),
  // unlike an <iframe>, which most sites forbid via X-Frame-Options. In the plain-browser demo we
  // fall back to an iframe plus an "open externally" escape hatch for sites that refuse embedding.
  const isE = /Electron/i.test(navigator.userAgent);
  let start = tab.url && tab.url !== "about:blank" ? tab.url : "";
  if (start && !/^https?:|^about:/.test(start)) start = "https://" + start; // normalize so it isn't loaded relative to the daemon
  const frame = isE
    ? '<webview src="' + escAttr(start || "about:blank") + '" partition="persist:external-apps" allowpopups></webview>'
    : '<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" src="' + escAttr(start) + '"></iframe>';
  tab.pane.innerHTML =
    '<div class="browbar">' +
    '<button class="nav" data-a="b" title="Back">‹</button><button class="nav" data-a="f" title="Forward">›</button><button class="nav" data-a="r" title="Reload">⟳</button>' +
    '<input placeholder="Enter a URL…" value="' + escAttr(start) + '"><button class="go">Go</button></div>' +
    frame + (isE ? "" : '<div class="brownote"></div>');
  const inp = $("input", tab.pane),
    view = isE ? $("webview", tab.pane) : $("iframe", tab.pane),
    note = $(".brownote", tab.pane);
  // Derive a short tab title from the host (strip scheme + trailing slashes, cap length).
  const setTitle = (u) => {
    tab.title = u.replace(/^https?:\/\//, "").replace(/\/+$/, "").slice(0, 22) || "Browser";
    renderTabbar();
  };
  // Navigate the view to a typed address, defaulting the scheme to https.
  const nav = (raw) => {
    let u = (raw || "").trim();
    if (!u) return;
    if (!/^https?:|^about:/.test(u)) u = "https://" + u;
    view.src = u;
    inp.value = u;
    setTitle(u);
  };
  $(".go", tab.pane).onclick = () => nav(inp.value);
  inp.onkeydown = (e) => {
    if (e.key === "Enter") nav(inp.value);
  };
  tab.pane.querySelectorAll(".nav").forEach((b) => b.onclick = () => {
    const a = b.dataset.a;
    // Desktop <webview> has real back/forward/reload; the iframe fallback can only reload.
    if (isE) {
      if (a === "b") {
        try {
          view.goBack();
        } catch (x) {}
      } else if (a === "f") {
        try {
          view.goForward();
        } catch (x) {}
      } else {
        try {
          view.reload();
        } catch (x) {}
      }
    } else if (a === "r") {
      view.src = view.src; // reassigning src forces the iframe to reload.
    }
  });
  if (isE) {
    // Keep the address bar and tab title in step with in-webview navigation.
    view.addEventListener("did-navigate", (e) => {
      if (e.url) {
        inp.value = e.url;
        setTitle(e.url);
      }
    });
    view.addEventListener("page-title-updated", (e) => {
      if (e.title) {
        tab.title = e.title.slice(0, 22);
        renderTabbar();
      }
    });
  } else {
    // Iframe fallback: many sites refuse embedding, so offer an "open in a new tab" escape hatch.
    note.innerHTML = 'Blank page? The site blocks being embedded here. <a href="#" class="ext">Open in a new tab ↗</a> - or run <code>npm run demo:app</code>, where pages load inline.';
    $(".ext", note).onclick = (ev) => {
      ev.preventDefault();
      let u = inp.value.trim();
      if (!u) return;
      window.open(/^https?:/.test(u) ? u : "https://" + u, "_blank", "noopener");
    };
  }
}
