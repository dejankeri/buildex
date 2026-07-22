; BuildEx NSIS customizations. electron-builder !include's this file (see electron-builder.yml
; nsis.include) and invokes the macros it defines around the generated (un)installer.
;
; Why this exists: electron-updater downloads each update into a cache under
; %LOCALAPPDATA%\<name>-updater and the default uninstaller never removes it, so uninstalling BuildEx
; strands the cached installer (~95 MB). We delete it on uninstall. Best-effort by construction: RMDir
; on a path that doesn't exist is a no-op, so covering the known folder-name candidates is safe - the
; cache folder is named from the product name / package name depending on the electron-updater version.
!macro customUnInstall
  RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}-updater"
  RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
!macroend
