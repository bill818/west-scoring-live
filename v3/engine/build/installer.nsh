; WEST Engine — custom NSIS installer hooks for electron-builder.
; Two responsibilities:
;   1. Force install path to c:\west-engine (overrides Program Files default)
;   2. Post-install: create c:\west\v3 state dir + drop config.json skeleton
;      if it doesn't already exist (preserves existing config on reinstall)

!macro preInit
  ; Override $INSTDIR before electron-builder reads it. Both registry views
  ; cover 32/64-bit, both hives cover per-user/per-machine — electron-builder
  ; picks the right one based on perMachine + isAdmin.
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\west-engine"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\west-engine"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\west-engine"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\west-engine"
!macroend

!macro customInstall
  ; Engine state dir — logs, config, crash log all live here. Separate from
  ; the install dir so updates/uninstall don't touch operator data.
  CreateDirectory "C:\west\v3"

  ; Drop a config.json with credentials baked in ONLY if the file doesn't
  ; exist. Preserves operator-edited config on reinstall / upgrade.
  ; Worker URL and auth key are hardcoded — these installers are
  ; distributed only to Worthington-operated scoring PCs. To rotate
  ; credentials: edit this file, rebuild, redistribute.
  IfFileExists "C:\west\v3\config.json" skipConfig 0
    FileOpen $0 "C:\west\v3\config.json" w
    FileWrite $0 "{$\r$\n"
    FileWrite $0 '  "workerUrl": "https://west-worker.bill-acb.workers.dev",$\r$\n'
    FileWrite $0 '  "authKey": "west-scoring-2026",$\r$\n'
    FileWrite $0 '  "showSlug": null,$\r$\n'
    FileWrite $0 '  "ringNum": null$\r$\n'
    FileWrite $0 "}$\r$\n"
    FileClose $0
  skipConfig:
!macroend

!macro customUnInstall
  ; Do NOT remove c:\west\v3 — that's operator data (config + logs +
  ; crash history). Uninstall removes the binary only.
!macroend
