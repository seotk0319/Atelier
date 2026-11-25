; Atelier — 바로가기는 electron-builder 기본 매크로가 만든다 (AUMID 포함).
; 0.2.0 설치판은 제거 단계에서 Atelier 바로가기를 직접 지웠다. 그 판에서 업데이트하면 기본 매크로가
; 「바로가기 유지」로 판단해 다시 만들지 않으므로, 시작 메뉴 바로가기가 없을 때만 여기서 채운다.

!macro customInstall
  ${ifNot} ${FileExists} "$SMPROGRAMS\Atelier.lnk"
    CreateShortCut "$SMPROGRAMS\Atelier.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    ClearErrors
    WinShell::SetLnkAUMI "$SMPROGRAMS\Atelier.lnk" "${APP_ID}"
  ${endIf}
!macroend
