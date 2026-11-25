/**
 * 모달 창·우클릭 메뉴·열린 선택 목록이 떠 있는지.
 * 뒤 화면의 전역 키(화살표·즐겨찾기·단축키)가 그 위에서 같이 먹지 않게 할 때 쓴다.
 * 모달 창은 components/ui/dialog.tsx의 DialogContent가 data-modal-dialog를 단다.
 */
export function overlayOpen(): boolean {
  return Boolean(
    document.querySelector(
      '[data-modal-dialog], [role="menu"], [role="listbox"][data-state="open"]'
    )
  )
}
