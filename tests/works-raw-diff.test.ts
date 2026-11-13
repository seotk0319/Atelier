import { describe, expect, it } from 'vitest'
import { rawCheck, rawDiff } from '../src/main/works/raw-diff'

describe('원본째 견주기', () => {
  it('같으면 빈 목록, 다른 칸은 경로와 값의 모양만 돌려준다 (내용은 싣지 않는다)', () => {
    const a = { name: '작품', hidden: { tags: ['a', 'b'], note: '비밀 글' } }
    expect(rawDiff(a, structuredClone(a))).toEqual([])
    const b = { name: '작품', hidden: { tags: ['a'], note: '다른 글입니다' } }
    const diff = rawDiff(a, b)
    expect(diff).toEqual([
      { path: 'hidden.tags[1]', kind: 'removed', before: '글 1자' },
      { path: 'hidden.note', kind: 'changed', before: '글 4자', after: '글 7자' }
    ])
    expect(JSON.stringify(diff)).not.toContain('비밀')
  })

  it('번호 칸이 있는 목록은 번호로 짝짓는다: 끼워 넣어도 뒤 항목이 달라졌다고 하지 않는다', () => {
    const a = { lore: [{ id: 1, text: '가' }, { id: 2, text: '나' }] }
    const b = { lore: [{ id: 1, text: '가' }, { id: 9, text: '새' }, { id: 2, text: '나' }] }
    expect(rawDiff(a, b)).toEqual([{ path: 'lore[id=9]', kind: 'added', after: '묶음 2칸' }])
    const swapped = { lore: [{ id: 2, text: '나' }, { id: 1, text: '가' }] }
    expect(rawDiff(a, swapped)).toEqual([{ path: 'lore (순서)', kind: 'changed' }])
  })

  it('번호가 없거나 겹치는 목록은 자리로 짝짓는다', () => {
    const a = { list: [{ id: 1, v: 1 }, { id: 1, v: 2 }] }
    const b = { list: [{ id: 1, v: 1 }, { id: 1, v: 3 }] }
    expect(rawDiff(a, b)).toEqual([{ path: 'list[1].v', kind: 'changed', before: '2', after: '3' }])
  })

  it('limit에서 멈춘다', () => {
    const a = { list: Array.from({ length: 50 }, (_, i) => i) }
    const b = { list: Array.from({ length: 50 }, (_, i) => i + 1) }
    expect(rawDiff(a, b, 10)).toHaveLength(10)
  })

  it('rawCheck: 서버가 스스로 바꾸는 칸은 문제로 치지 않고 개수만 센다', () => {
    const sent = { title: '제목', updatedAt: '1', version: 3, upd_dt: 'x', curationTags: ['a'] }
    const saved = { title: '제목', updatedAt: '2', version: 4, upd_dt: 'y', curationTags: ['a'] }
    expect(rawCheck(sent, saved)).toEqual({
      same: true,
      differences: [],
      more: 0,
      server_fields: 3,
      ignored: 0,
      empty_swaps: 0
    })

    const lost = { title: '제목', updatedAt: '2', version: 4, upd_dt: 'y', curationTags: [] }
    const check = rawCheck(sent, lost)
    expect(check.same).toBe(false)
    expect(check.differences).toEqual([
      { path: 'curationTags[0]', kind: 'removed', before: '글 1자' }
    ])
  })

  it('rawCheck: 빈 글과 null이 서로 바뀐 것은 문제로 치지 않고 개수만 센다', () => {
    const check = rawCheck({ subtitle: '', note: null, name: '가' }, { subtitle: null, note: '', name: '가' })
    expect(check).toMatchObject({ same: true, differences: [], empty_swaps: 2 })
    // 값이 있던 글이 null이 된 것은 문제다
    expect(rawCheck({ subtitle: '글' }, { subtitle: null }).same).toBe(false)
  })

  it('rawCheck: 연결부가 적어 둔 경로는 문제로 치지 않고 개수만 센다', () => {
    const sent = { form: { name: '가' }, character: { name: '옛' }, list: [{ order: 1 }] }
    const saved = { form: { name: '가' }, character: { name: '가' }, list: [{ order: 2 }] }
    expect(rawCheck(sent, saved).same).toBe(false)
    const check = rawCheck(sent, saved, 30, [/^character\b/, /\.order$/])
    expect(check).toMatchObject({ same: true, differences: [], ignored: 2 })
  })

  it('rawCheck: 다른 곳이 많으면 앞의 max개만 싣고 나머지는 개수로', () => {
    const sent = { list: Array.from({ length: 40 }, (_, i) => 'a' + i) }
    const saved = { list: Array.from({ length: 40 }, (_, i) => 'b' + i) }
    const check = rawCheck(sent, saved, 5)
    expect(check.differences).toHaveLength(5)
    expect(check.more).toBe(35)
  })
})
