import { describe, expect, it } from 'vitest'
import { matchOld } from '../src/main/works/match-old'

interface Item {
  id: number
  title: string
  text?: string
}
const old: Item[] = [
  { id: 1, title: '가' },
  { id: 2, title: '나' },
  { id: 3, title: '다' }
]
const ids = (titles: string[]): (number | undefined)[] =>
  matchOld(titles, old, (o) => o.title).map((o) => o?.id)

describe('전체 교체 짝짓기', () => {
  it('그대로면 그대로 잇는다', () => {
    expect(ids(['가', '나', '다'])).toEqual([1, 2, 3])
  })
  it('순서를 바꿔도 제목이 같은 옛 항목을 따라간다', () => {
    expect(ids(['다', '가', '나'])).toEqual([3, 1, 2])
  })
  it('중간에 끼워 넣은 항목은 옛 항목을 물려받지 않는다', () => {
    expect(ids(['가', '새', '나', '다'])).toEqual([1, undefined, 2, 3])
  })
  it('중간을 빼도 뒤 항목이 제 번호를 지킨다', () => {
    expect(ids(['가', '다'])).toEqual([1, 3])
  })
  it('제자리에서 제목만 고치면 그 자리의 옛 항목을 잇는다', () => {
    expect(ids(['가', '나2', '다'])).toEqual([1, 2, 3])
  })
  it('순서를 바꾸면서 제목도 고친 항목은 남의 번호를 물려받지 않는다', () => {
    // 옛 [가, 나, 다] → 새 [다, 나2, 가]: 나2는 자리(1)의 옛 항목이 비어 있어도 잇지 않는다
    expect(ids(['다', '나2', '가'])).toEqual([3, undefined, 1])
  })
  it('끼워 넣으면서 제목을 고친 항목도 잇지 않는다', () => {
    expect(ids(['새', '가', '나2', '다'])).toEqual([undefined, 1, undefined, 3])
  })
  it('같은 제목이 여럿이면 제자리 것을 먼저, 남으면 앞에서부터 쓴다', () => {
    const twins: Item[] = [
      { id: 1, title: '같음' },
      { id: 2, title: '같음' }
    ]
    expect(matchOld(['같음', '같음', '같음'], twins, (o) => o.title).map((o) => o?.id)).toEqual([
      1,
      2,
      undefined
    ])
  })
  it('끝에 붙인 항목은 새 항목이다', () => {
    expect(ids(['가', '나', '다', '라'])).toEqual([1, 2, 3, undefined])
  })

  describe('내용까지 견주기 (제목이 겹치거나 빈 플랫폼)', () => {
    const untitled: Item[] = [
      { id: 1, title: '', text: '하나' },
      { id: 2, title: '', text: '둘' },
      { id: 3, title: '', text: '셋' }
    ]
    const match = (contents: string[]): (number | undefined)[] =>
      matchOld(
        contents.map(() => ''),
        untitled,
        (o) => o.title,
        { contents, contentOf: (o) => o.text ?? '' }
      ).map((o) => o?.id)

    it('순서를 뒤집어도 내용이 같은 옛 항목을 따라간다', () => {
      expect(match(['셋', '둘', '하나'])).toEqual([3, 2, 1])
    })
    it('제자리에서 내용을 고치면 그 자리의 옛 항목을 잇는다', () => {
      expect(match(['하나', '둘 고침', '셋'])).toEqual([1, 2, 3])
    })
    it('앞에 끼워 넣어도 뒤 항목들이 제 번호를 지킨다', () => {
      expect(match(['새', '하나', '둘', '셋'])).toEqual([undefined, 1, 2, 3])
    })
    it('제자리에서 제목만 고치든 제목과 내용을 함께 고치든 그 자리의 옛 항목을 잇는다', () => {
      const titled: Item[] = [
        { id: 1, title: '가', text: '하나' },
        { id: 2, title: '나', text: '둘' }
      ]
      const run = (titles: string[], contents: string[]): (number | undefined)[] =>
        matchOld(titles, titled, (o) => o.title, { contents, contentOf: (o) => o.text ?? '' }).map(
          (o) => o?.id
        )
      expect(run(['가', '나2'], ['하나', '둘'])).toEqual([1, 2])
      // 알려진 한계: 둘째를 지우고 다른 항목을 넣은 것과 가릴 수 없어 고친 것으로 본다
      expect(run(['가', '새'], ['하나', '전혀 다른 글'])).toEqual([1, 2])
    })
    it('꼭 같은 항목이 여럿이면 제자리를 지킨다', () => {
      const same: Item[] = [
        { id: 1, title: '', text: '같음' },
        { id: 2, title: '', text: '다름' },
        { id: 3, title: '', text: '같음' }
      ]
      expect(
        matchOld(['', '', ''], same, (o) => o.title, {
          contents: ['같음', '다름', '같음'],
          contentOf: (o) => o.text ?? ''
        }).map((o) => o?.id)
      ).toEqual([1, 2, 3])
    })
  })
})
