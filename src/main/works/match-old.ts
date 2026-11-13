// "전체 교체"로 받은 새 항목들을 옛 항목과 짝짓는다.
// 자리 번호로만 짝지으면 항목을 끼워 넣거나 순서를 바꿨을 때 옛 항목의 번호·숨은 설정(적용 범위, 의존 관계,
// 켜짐 상태 등)이 엉뚱한 새 항목에 붙는다. 그래서 제목(과 내용)으로 짝짓고, 제자리에서 제목만 고친 경우만 자리로 잇는다.

/**
 * 새 항목마다 물려받을 옛 항목을 돌려준다 (없으면 undefined: 새로 생기는 항목이다).
 * 옛 항목 하나는 한 번만 쓰인다. 차례:
 *  1. 제목과 내용이 모두 같은 옛 항목 (tie를 줬을 때만. 제목이 겹치거나 비어 있는 플랫폼에서 순서를 바꿔도 제 짝을 찾는다)
 *  2. 제목이 같고 자리도 같은 옛 항목 (제목이 겹치는 항목의 내용을 제자리에서 고친 경우)
 *  3. 제목이 같은 옛 항목 가운데 앞에서부터
 *  4. 짝을 못 찾은 새 항목은, 위에서 지어진 짝이 모두 제자리(순서가 바뀌지 않았고 끼워 넣지도 않음)일 때만
 *     같은 자리의 아직 안 쓰인 옛 항목을 잇는다 (제자리에서 제목을 고친 경우).
 *     순서가 바뀌었거나 끼워 넣었으면 잇지 않는다: 남의 번호를 물려받느니 새 항목으로 만든다.
 *     알려진 한계: "끝 항목을 지우고 그 자리에 전혀 다른 항목을 넣은 것"은 "그 항목의 제목과 내용을 고친 것"과
 *     입력만으로 가릴 수 없어, 고친 것으로 본다(제자리에서 제목과 내용을 함께 고치는 일이 훨씬 흔하고, 새 항목으로
 *     보면 그 항목의 발동 방식 같은 손대지 않은 설정이 기본값으로 돌아간다). 지우고 새로 넣으려면 전체 교체 대신
 *     lorebook_remove와 lorebook_add를 쓴다.
 */
export function matchOld<T>(
  titles: string[],
  old: readonly T[],
  titleOf: (item: T) => string,
  tie?: { contents: string[]; contentOf: (item: T) => string }
): (T | undefined)[] {
  const used = new Array<boolean>(old.length).fill(false)
  const at = new Array<number>(titles.length).fill(-1)
  const take = (i: number, j: number): void => {
    used[j] = true
    at[i] = j
  }
  const oldTitles = old.map(titleOf)

  if (tie) {
    const oldContents = old.map(tie.contentOf)
    titles.forEach((title, i) => {
      const exact = (j: number): boolean =>
        !used[j] && oldTitles[j] === title && oldContents[j] === tie.contents[i]
      // 같은 자리에 꼭 같은 항목이 있으면 그것부터 (똑같은 항목이 여럿일 때 자리를 지킨다)
      if (i < old.length && exact(i)) return take(i, i)
      const j = oldTitles.findIndex((_, k) => exact(k))
      if (j >= 0) take(i, j)
    })
  }
  titles.forEach((title, i) => {
    if (at[i] < 0 && i < old.length && !used[i] && oldTitles[i] === title) take(i, i)
  })
  titles.forEach((title, i) => {
    if (at[i] >= 0) return
    const j = oldTitles.findIndex((t, k) => !used[k] && t === title)
    if (j >= 0) take(i, j)
  })

  const inPlace = at.every((j, i) => j < 0 || j === i)
  if (inPlace)
    titles.forEach((_, i) => {
      if (at[i] >= 0 || i >= old.length || used[i]) return
      take(i, i)
    })
  return at.map((j) => (j < 0 ? undefined : old[j]))
}
