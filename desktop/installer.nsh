; Additions to electron-builder's NSIS installer (desktop/electron-builder.yml, `nsis.include`).
;
; The installer keeps a copy of itself in %LOCALAPPDATA%\<package name>-updater\installer.exe, for
; electron-builder's auto-updater. The app has no auto-updater, and electron-builder's uninstaller
; does not remove that copy (as big as the installer), nor its folder. Removing the app removes both.
; Not when the uninstaller runs as part of an upgrade: the new installer writes its own copy then.
; The application folder (data, configuration, logs) is kept, as `deleteAppDataOnUninstall: false` says.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    !ifdef APP_INSTALLER_STORE_FILE
      ; The app is installed for the current user only; electron-builder keeps the copy per user too.
      Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
      ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $R9
      ; Removed only when empty: nothing else is ever deleted.
      RMDir "$R9"
    !endif
  ${endIf}
!macroend
