# Electron auto-update - plan

**Status:** planned (not yet implemented) · **Owner:** TBD · **Applies to:** `apps/client`

The desktop app (`apps/client`) currently ships without a self-update path. This document is the
plan for adding auto-update: what we build, what it costs, and the constraints BuildEx's invariants
put on it. Nothing here is landed - treat it as the design contract to build against later.

## Goal

`apps/client` checks a release feed, downloads a newer signed build, and applies it - with the
operator in control of *when* it installs (see invariant constraints below). Works on macOS,
Windows, and Linux.

## The three pieces

Auto-update is three things working together:

1. **Updater library** - checks the feed, downloads, and swaps the binary.
2. **Release feed** - where built installers + update metadata are hosted.
3. **Code signing** - so the OS trusts the downloaded update (mandatory on macOS).

## Chosen stack

| Piece | Choice | Notes |
|---|---|---|
| Library | **`electron-updater`** (from `electron-builder`) | Native GitHub/S3/generic providers; handles `latest.yml` / `latest-mac.yml`. Preferred over raw Electron `autoUpdater`. |
| Feed | **GitHub Releases** | Free for public repos. `electron-updater` has a native GitHub provider. Covers macOS, Windows, Linux. |
| Build/publish | **GitHub Actions** | Free for public repos; per-OS matrix build, publishes installers on git tag. |
| macOS signing | **Apple Developer Program (Individual)** | $99/year. Mandatory - see cost matrix. |
| Windows signing | **SignPath.io OSS program** | Free code-signing certs for open-source projects. |
| Linux | AppImage | No signing required; `electron-updater` auto-updates AppImage. |

Alternative considered: **update.electronjs.org** (free hosted update server run by the Electron
team for OSS on public GitHub). Simpler, but uses Squirrel `autoUpdater` (macOS + Windows only, no
Linux) and still requires signed apps. Rejected in favor of `electron-updater` + GitHub Releases
for Linux coverage and provider flexibility.

## Cost & signing matrix

| Platform | Signing required for auto-update? | Free option |
|---|---|---|
| **macOS** | **Yes, mandatory** - Squirrel.Mac rejects unsigned updates; Gatekeeper needs notarization | ❌ None - **$99/year Apple Developer Program** |
| **Windows** | Updates work unsigned, but SmartScreen warns users | ✅ **SignPath.io** free OSS cert |
| **Linux** | No | ✅ Free |

**Only hard cost: $99/year Apple Developer membership.** Everything else is free for an OSS project.

### Apple enrollment notes

- Enroll as **Individual** (a private person can do this; Serbia is supported). Needs an Apple ID
  with 2FA and a card for the annual fee.
- Individual enrollment ⇒ the signing certificate and the "developer" name Gatekeeper shows are the
  enrollee's **personal legal name**, not "BuildEx". Auto-update/notarization work identically.
- Migrating to **Organization** later (to show "BuildEx" as seller) requires a D-U-N-S number and a
  registered legal entity. Start Individual; migrate if/when needed.

## Constraints from BuildEx invariants

- **Invariant #5 (wide autonomy, few gates).** Replacing the running binary is irreversible, so it
  falls in the gated set and must not be automatic. Design: download in the background, then surface
  an **approval card** - the operator chooses when to install/restart. Do **not** call
  `checkForUpdatesAndNotify()` in a way that force-installs.
- **Secrets stay private.** Apple certificates, notarization credentials, and the SignPath token are
  secrets - they live in CI secrets / the private repo, **never** in this public monorepo's history
  (ground rules + invariant on no secrets in-repo).
- **Capture the decision.** When the approach is finalized at implementation time, record a
  `capture-decision` entry (approval-gated update model, chosen provider, signing path).

## Implementation checklist (for later)

1. Add `electron-builder` + `electron-updater`; configure `publish` target → GitHub in the
   electron-builder config.
2. Wire update check into the main process **behind an approval surface** (background download →
   operator-approved install), not auto-install.
3. GitHub Actions: per-OS matrix build, publish installers + metadata on git tag.
4. Apply to **SignPath OSS program** for Windows signing; enroll in **Apple Developer (Individual)**
   and add notarization to the macOS build.
5. Store all signing/notarization credentials in CI secrets (private), never in-repo.

## Open questions

- Update cadence / channel strategy (stable vs. beta feeds)?
- Where exactly the approval card lives in the client UX (reuse the existing approval-card surface).
- Delta updates vs. full-binary swaps - likely defer; full swaps are fine at M1 scale.
