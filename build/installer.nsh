; Atelier — 바로가기는 이 스크립트가 직접 만든다 (기본 바로가기는 electron-builder.yml에서 끔).
; 프로필은 항상 1이라 인자 없이 띄운다. 예전 NAIS3 Custom 바로가기는 건드리지 않는다.

!macro customInstall
  CreateShortcut "$DESKTOP\Atelier.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortcut "$SMPROGRAMS\Atelier.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  ; 업데이트 설치도 이전 판의 제거 단계를 거친다 — 그때 지운 바로가기는 위 customInstall이 다시 만든다
  Delete "$DESKTOP\Atelier.lnk"
  Delete "$SMPROGRAMS\Atelier.lnk"
!macroend
