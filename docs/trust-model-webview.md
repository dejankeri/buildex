# Trust model: embedded external content (`<webview>`)

BuildEx renders two kinds of embedded surface in the desktop app:

- **External-app tabs** — a connected app (Notion, Stripe, Linear, …) shown inline so the operator
  can glance at it beside the agent. (`web/js/apps.js`)
- **The in-app "Web browser" tab** — a general browser surface that loads any site.
  (`web/js/browser.js`)

In the packaged desktop app both are Electron `<webview>` guests. In the plain-browser demo they
fall back to a sandboxed `<iframe>` with an explicit `sandbox` allowlist.

## The rule

**An embedded site is a foreign browser tab, never part of BuildEx.** It is the least-trusted
surface in the app: it loads arbitrary third-party HTML/JS. So it is confined on every axis a guest
can be confined, in the Electron main process (`electron/main.cjs`) — the web/renderer layer cannot
grant itself more than this:

| Axis | Confinement | Where |
|---|---|---|
| Node / preload | `nodeIntegration:false`, `nodeIntegrationInSubFrames:false`, `contextIsolation:true`, any page-supplied `preload` stripped | `will-attach-webview` |
| Scheme | `src` forced to `about:blank` unless it is `http(s)` — never `file://`, `chrome://`, `javascript:` | `sanitizeWebviewSrc` (`external-url.cjs`), tested |
| Popups / `window.open` | routed to the operator's **real** browser via `shell.openExternal`; never a chromeless in-app window (so an OAuth popup opens where the real URL bar is visible) | `did-attach-webview` → guest `setWindowOpenHandler` |
| Permissions | **every** request denied — camera, microphone, geolocation, notifications, MIDI, … | `setPermissionRequestHandler`/`setPermissionCheckHandler` on the external session |
| Session isolation | all external content runs in a dedicated `persist:external-apps` partition, so its cookies and the locked-down permission handlers never touch the loopback console's own session | `partition="persist:external-apps"` on the `<webview>` + `session.fromPartition` in main |

The main **window** itself (the loopback console) is already hardened separately: `contextIsolation`
on, `nodeIntegration` off, and any external navigation/link handed out to the OS browser
(`isExternalUrl` → `shell.openExternal`).

## Why `allowpopups` is still set

The external-app OAuth flows sometimes open a popup to authorize. Rather than block popups outright
(which breaks those flows), the guest keeps `allowpopups` but its window-open handler sends the popup
to the operator's real browser — the safe place to type a credential, because the real URL bar is
visible. The guest never gets to open a chromeless window that could spoof one.

## Not yet covered (roadmap)

- A per-app **navigation allowlist** (pin an external-app tab to its own origin) — today a guest may
  navigate freely within `http(s)`. Tracked with the mini-app sandbox work (H5).
- Content-Security-Policy injection into guests — guests bring their own CSP; we do not override it.
