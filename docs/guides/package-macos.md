# Packaging a signed, notarized macOS build

This is the release-machine runbook for producing a **notarized `.dmg`** that launches on a clean Mac
with no Gatekeeper warning. It runs on a maintainer's Mac, never in CI — Apple credentials live only in
that machine's environment and **never enter git** (repo invariant: outward/irreversible creds come from
ENV at build time).

## One-time Apple setup

You need two things from your Apple Developer account (Developer Program membership required):

1. **A "Developer ID Application" certificate** in your login keychain. Create it in
   **Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application**. Verify:
   ```bash
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```
   (This is distinct from an "Apple Development" certificate, which only signs for local testing.)

2. **An App Store Connect API key** for notarization. Create it at
   **App Store Connect → Users and Access → Integrations → App Store Connect API → +** (role: Developer).
   Save the downloaded `.p8` **outside the repo** (e.g. `~/.private-keys/AuthKey_<KeyID>.p8`) — it can
   only be downloaded once. Note the **Key ID**, the **Issuer ID**, and your **Team ID** (Membership page).

## Build-time environment

Set these in the release shell (or a git-ignored `.env` you `source`) — never commit them:

```bash
export APPLE_TEAM_ID="XXXXXXXXXX"                              # your 10-char Team ID
export APPLE_API_KEY="$HOME/.private-keys/AuthKey_ABCDE12345.p8"
export APPLE_API_KEY_ID="ABCDE12345"                          # the Key ID
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000" # the Issuer ID (UUID)
# Optional: if more than one Developer ID cert is in the keychain, pin it:
# export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
```

electron-builder's `mac.notarize: true` activates `@electron/notarize`, which reads **all** Apple
credentials from these env vars — the App Store Connect API key (`APPLE_API_KEY` / `_KEY_ID` / `_ISSUER`)
plus `APPLE_TEAM_ID`. Nothing Apple-specific lives in the committed config.

## Build

electron-builder is intentionally **not** a committed dependency (it would bloat CI with ~220 packages).
Install it on the release machine, then build:

```bash
npm ci                                     # from the repo root
npm i -D electron-builder@^26 -w @buildex/client   # release machine only; do NOT commit the package.json/lock change
npm run -w @buildex/client build:daemon    # esbuild → apps/client/build/daemon.cjs (bundled daemon)
npm run -w @buildex/client package:mac     # electron-builder → apps/client/dist/BuildEx-*.dmg
```

`package:mac` signs with the hardened runtime + `entitlements.mac.plist`, submits to the notary service,
waits for the ticket, and staples it into the `.dmg`.

**Unsigned local validation** (no Apple account needed — proves the bundle assembles and launches):

```bash
npm run -w @buildex/client package:mac:unsigned
```

The working directory matters: electron-builder resolves the config's relative paths (the
`extraResources` `scripts/gate-hook.mjs` and `../../packs/core`) against the CWD, so the build MUST
run from `apps/client/` — otherwise those resources vanish from the bundle and it hard-fails on the
entry file. The `package:mac:unsigned` script handles this (npm `-w` sets the CWD to the workspace)
and disables signing + notarization. Equivalent raw command, if you prefer to run it by hand:

```bash
cd apps/client && CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --mac -c.mac.notarize=false
```

## Verify on a clean Mac

Copy the `.dmg` to a Mac that never saw the build, then:

```bash
spctl -a -vvv -t install /Volumes/BuildEx/BuildEx.app   # → "accepted, source=Notarized Developer ID"
codesign --verify --deep --strict --verbose=2 /Volumes/BuildEx/BuildEx.app
xcrun stapler validate /path/to/BuildEx-*.dmg           # → "The validate action worked!"
```

Then open the app: it should launch with no "unidentified developer" prompt, boot the bundled daemon on
loopback, and open onto the org switcher with the **Acme Labs** demo sandbox ready.

## Publish the release

0. **Bump the version to match the tag** — do this BEFORE building. Set `apps/client/package.json`
   `version` to the release version (e.g. `0.1.0`); electron-builder names the artifact from it, so
   the DMG is `BuildEx-<version>-arm64.dmg` and it must line up with the git tag `v<version>`. Keep
   the root `package.json` and the other apps' versions in sync. Then run the Build steps above.
1. Create a GitHub release on `dejankeri/buildex` (tag e.g. `v0.1.0`) and upload the notarized `.dmg`
   (and its `.blockmap` if present) as release assets.
2. Flip the download page live: in `apps/site/public/download.html`, enable **only the Apple Silicon**
   macOS card — remove its `aria-disabled="true"` and its `<span class="soon">soon</span>`. **Leave the
   Intel card as "soon"**: the build produces an arm64-only DMG (`electron-builder.yml` has
   `mac.target: dmg` with no arch list), so there is no x64 artifact to link yet. The Apple Silicon
   card's `href` already points at `https://github.com/dejankeri/buildex/releases/latest`, so it
   resolves to the newest build with no per-version edit. Commit + redeploy the site.
3. Sanity-check the link from an incognito window: it should land on the release with the `.dmg` visible.

> **Adding Intel later:** produce an x64 build by setting `arch: [arm64, x64]` under `mac.target` in
> `electron-builder.yml` — electron-builder then emits a second DMG (`BuildEx-<version>-x64.dmg`) and
> notarizes each arch separately. Once that artifact ships, enable the Intel download card the same way
> and add a `darwin-x64` entry to `infra/latest.json.example`.

## Troubleshooting

- **`The specified item could not be found in the keychain`** — the Developer ID cert isn't installed, or
  `CSC_NAME` doesn't match. Re-check step 1.
- **Notarization `Invalid` / rejected** — run `xcrun notarytool log <submission-id> --key ... --key-id ...
  --issuer ...` for the per-file reason; the usual cause is a binary missing the hardened runtime or an
  entitlement (see `entitlements.mac.plist`).
- **App crashes on launch after signing** — almost always a missing entitlement; V8 needs
  `allow-jit` + `allow-unsigned-executable-memory`, and spawning `claude` needs
  `disable-library-validation`. All four are already in the plist.
