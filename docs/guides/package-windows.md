# Packaging a Windows build

This is the build-machine runbook for producing the Windows **`.exe` installer**. It runs on a
maintainer's Windows 10/11 machine, never in CI — same as the macOS build, and for the same reason:
electron-builder is not a committed dependency.

Unlike macOS, this build is **unsigned**. There is no Authenticode certificate, so the installer
trips SmartScreen on a clean machine (see [Verify](#verify-on-a-clean-windows-machine)). That is
why the README lists a signed Windows download under "Not yet" while macOS ships one-click.

## Prerequisites

- **Windows 10 or 11.** electron-builder's NSIS target needs a real Windows host; there is no
  cross-build from macOS in this setup.
- **Node 22+** and **git**.
- No certificate, no Apple-style account, no environment secrets. Nothing here touches credentials —
  the whole difference from `package-macos.md` is that there is nothing to sign with.

## Build

electron-builder is intentionally **not** a committed dependency (it would add ~220 packages to CI).
Install it on the build machine, then build:

```sh
npm ci                                              # from the repo root
npm i -D electron-builder@^26 -w @buildex/client    # build machine only; do NOT commit the package.json/lock change
npm run -w @buildex/client build:daemon             # esbuild → apps/client/build/daemon.cjs (bundled daemon)
npm run -w @buildex/client package:win              # electron-builder → apps/client/dist/BuildEx Setup <version>.exe
```

`build:daemon` is a **separate step on purpose and is not run for you** — `package:win` only packages
whatever `build/daemon.cjs` currently holds. Skip it and you ship a stale daemon inside a fresh
installer, which looks like a code change that silently did nothing. Same footgun as `package:mac`.

The build is **x64 only** (`archs=x64` in the build log). Windows on ARM has no artifact yet; adding
one means an `arch` list under `win.target` in `electron-builder.yml`, the same way the macOS guide
describes adding Intel.

The working directory matters: electron-builder resolves the config's relative paths (the
`extraResources` `scripts/gate-hook.mjs` and `../../packs/core`) against the CWD, so the build MUST
run from `apps/client/`. The npm `-w` flag sets that for you. Equivalent raw command:

```sh
cd apps/client && npx electron-builder --win -c.extraMetadata.name=BuildEx
```

### Why `package:win` renames the package metadata

That `-c.extraMetadata.name=BuildEx` is not cosmetic noise — it is the only lever that fixes the
install folder.

For a **one-click, per-user** installer electron-builder ignores `productName` entirely and names the
install directory from the **npm package name**:

```js
// app-builder-lib/out/targets/targetUtil.js
getWindowsInstallationDirName(appInfo, isTryToUseProductName) {
  return isTryToUseProductName && /^[-_+0-9a-zA-Z .]+$/.test(appInfo.productFilename)
    ? appInfo.productFilename   // "BuildEx"
    : appInfo.sanitizedName     // "@buildex/client" → "@buildexclient"
}
// called with: !oneClick || isPerMachine   → false && false → false
```

Our package is scoped (`@buildex/client`), so without the override the operator gets
`%LOCALAPPDATA%\Programs\@buildexclient`. There is **no nsis option** for the install directory, and
the alternatives both cost more than they are worth:

| Route | Folder | Cost |
|---|---|---|
| `-c.extraMetadata.name=BuildEx` | `Programs\BuildEx` | packaged metadata name differs from `package.json` |
| `nsis.oneClick: false` | `Programs\BuildEx` | adds installer wizard pages the operator must click through |
| `nsis.perMachine: true` | `Program Files\BuildEx` | requires an admin prompt on every install |

The override is set **in the `package:win` script, not in `electron-builder.yml`**, because that file
also drives the macOS release. `extraMetadata` is top-level config with no per-platform form, so
putting it in the yml would silently rename the metadata inside the shipping `.dmg` too. Scoping it
to the Windows command keeps the mac path byte-identical.

This does not affect the app at runtime: `electron/main.cjs` calls `app.setName("BuildEx")` before it
touches any path, so `userData` is `%APPDATA%\BuildEx` either way.

> **The rename only lands on a fresh install.** `multiUser.nsh` reads the previous install location
> out of `HKCU\...\InstallLocation` and reuses it when present, so upgrading an existing
> `@buildexclient` install stays in the old folder. Uninstall first if you want the new one.

## Verify on a clean Windows machine

Copy the `.exe` to a machine that never saw the build.

1. **SmartScreen appears — this is expected while unsigned.** "Windows protected your PC" → *More
   info* → *Run anyway*. If you want to confirm the file arrived intact first:
   ```powershell
   Get-FileHash "BuildEx Setup <version>.exe" -Algorithm SHA256
   ```
2. **Install.** One click, no admin prompt. It should not launch itself afterwards
   (`nsis.runAfterFinish: false`) — that is deliberate, so a post-install instance cannot race a
   manual launch onto the same workspace.
3. **Check where it landed:**
   ```powershell
   Test-Path "$env:LOCALAPPDATA\Programs\BuildEx\BuildEx.exe"      # → True
   Get-ItemProperty "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*" |
     Where-Object DisplayName -match BuildEx | Select DisplayName, InstallLocation
   ```
4. **Launch it.** It should boot the bundled daemon on loopback and open onto the org switcher with
   the **Acme Labs** demo sandbox ready — the same first-run as macOS.
5. **Confirm the agent is found.** The Windows resolver (`src/agent/win32-resolve.ts`) exists because
   `spawn()` cannot see a `claude.cmd` shim. If Claude Code was installed via npm rather than the
   native installer, this is the case that used to report "unavailable" while the operator's own
   terminal ran `claude` fine. A packaged build is the only place that path runs for real.

## Uninstall

Settings → Apps → Installed apps → BuildEx → Uninstall, or run
`%LOCALAPPDATA%\Programs\BuildEx\Uninstall BuildEx.exe` (add `/S /currentuser` to do it silently).

It removes the app, the registry entry and both shortcuts. It does **not** remove:

- `%APPDATA%\BuildEx` — Electron `userData`: sessions, window state, cache
- the demo dir (`~/.buildex-demo`) if one was used
- **`%LOCALAPPDATA%\buildex-updater\installer.exe` — a full ~95 MB copy of the installer.** NSIS
  caches it at install time (`copyFile "$EXEPATH" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"` in
  `installer.nsh`) and **no uninstall path in electron-builder's templates ever deletes it**. This is
  upstream behaviour affecting every electron-builder NSIS app, not something this repo introduced —
  but it means each install permanently costs ~95 MB that uninstalling does not reclaim. Delete it by
  hand if you are reclaiming space.
  > Machines that installed a build from before the folder rename will have a second, orphaned
  > `%LOCALAPPDATA%\@buildexclient-updater\installer.exe` as well, since the cache directory is named
  > from the same package name the install folder is.
- **OS keychain entries.** Credentials are stored under a service id derived from the workspace path
  (`keychainService()`), and the `Keychain` interface has no `list()`, so entries whose workspace is
  gone cannot be enumerated or removed by anything — including the app. Uninstalling leaves them
  behind. This is a known open design question, not Windows-specific: macOS has the same shape and no
  uninstall hook at all.

## Publish the release

There is no Windows release channel yet — the site's download page ships macOS only, and the README
lists "a signed Windows download" under **Not yet**. Until an Authenticode certificate exists, the
`.exe` is for testing and manual distribution.

When that changes, the version rules are the same ones in
[`package-macos.md`](package-macos.md#publish-the-release): **bump `apps/client/package.json`
`version` to match the git tag before building**, keeping the root and other workspace versions in
sync. There is a single `version` for the whole app, and it names both artifacts —
`BuildEx-<version>-arm64.dmg` and `BuildEx Setup <version>.exe`. Never bump it as part of an ordinary
PR; it belongs to cutting a release.

## Troubleshooting

- **`electron-builder: not found`** — you skipped the `npm i -D electron-builder@^26` step. It is
  deliberately absent from the committed manifest.
- **The log says `signing with signtool.exe` — is it signed?** No. electron-builder prints that line
  for each binary regardless, and with no certificate configured the step is a no-op. Do not read it
  as a signature. Check for real:
  ```powershell
  (Get-AuthenticodeSignature "dist\BuildEx Setup <version>.exe").Status   # → NotSigned
  ```
- **Installer builds but the app dies on launch with a missing entry file** — you ran electron-builder
  from the repo root instead of `apps/client/`. The `extraResources` paths are CWD-relative and
  silently resolve to nothing. Use `npm run -w @buildex/client package:win`.
- **Your code change isn't in the installed app** — you skipped `build:daemon`. `package:win` packages
  the existing `build/daemon.cjs` without rebuilding it.
- **The install folder is still `@buildexclient`** — an older build is still installed and NSIS reused
  its recorded path. Uninstall, then install again.
