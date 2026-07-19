"use strict";

// Decide whether a URL the app tried to open should hand off to the operator's real browser.
// External http(s) links — an OAuth provider's authorize page, the marketing site — open in the OS
// browser via shell.openExternal; anything on the app's own loopback origin (incl. the OAuth callback
// path) stays in the window. Kept pure and separate from main.cjs so it can be unit-tested.
function isExternalUrl(url, appOrigin) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  try {
    return new URL(url).origin !== new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

// A <webview> guest (the external-app tabs + the in-app browser) is the least-trusted surface in the
// app - it loads arbitrary third-party sites. It must ONLY ever be pointed at real web content: force
// anything that isn't http(s) (a file://, chrome://, javascript:, or a malformed src) to a blank page,
// so a guest can never be aimed at a local or privileged scheme. Pure, so main.cjs can be tested.
function sanitizeWebviewSrc(src) {
  return typeof src === "string" && /^https?:\/\//i.test(src) ? src : "about:blank";
}

module.exports = { isExternalUrl, sanitizeWebviewSrc };
