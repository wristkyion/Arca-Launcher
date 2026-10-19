
!macro NSIS_HOOK_POSTINSTALL

  DetailPrint "Creating Arca Launcher directories..."

  ; Create required directories during installation
  CreateDirectory "$INSTDIR\game"
  CreateDirectory "$INSTDIR\jre"
  CreateDirectory "$INSTDIR\launcher"

  DetailPrint "Configuring directory permissions..."

  ; Allow standard users to modify game data
  ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR\game" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q' $0

  ; Allow standard users to modify the managed Java runtime
  ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR\jre" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q' $0

  ; Allow standard users to modify launcher-managed data
  ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR\launcher" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q' $0

!macroend
