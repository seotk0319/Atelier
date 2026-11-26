import { describe, expect, it } from 'vitest'
import { groupWorks } from '../src/main/notifications/work-groups'

describe('제목으로 묶기', () => {
  const w = (platform: string, id: string, title: string, at: string) => ({
    platform,
    id,
    title,
    url: 'https://x/' + id,
    at,
    atKind: 'published' as const,
    isPublic: true,
    image: null
  })
  it('문장부호 차이는 같은 작품, 먼저 올린 곳부터', () => {
    const g = groupWorks([
      w('crack', '1', '대나무숲의 빌런이 되었다', '2026-10-16T00:00:00Z'),
      w('eden', '2', '대나무숲의 빌런이 되었다.', '2026-10-11T00:00:00Z')
    ])
    expect(g).toHaveLength(1)
    expect(g[0].works.map((x) => x.platform)).toEqual(['eden', 'crack'])
  })
  it('끝 글자가 잘린 제목은 후보가 하나일 때만 잇는다', () => {
    const g = groupWorks([
      w('eden', '1', '과외생 길들이기', '2026-09-29T00:00:00Z'),
      w('teapot', '2', '과외생 길들이', '2026-10-10T00:00:00Z'),
      w('eden', '3', '잔향', '2026-04-28T00:00:00Z'),
      w('crack', '4', '잔', '2026-04-28T00:00:00Z')
    ])
    const merged = g.find((x) => x.works.length === 2)!
    expect(merged.title).toBe('과외생 길들이기')
    expect(merged.works.map((x) => x.platform)).toEqual(['eden', 'teapot'])
    // 짧은 제목은 잇지 않는다
    expect(g).toHaveLength(3)
  })
})
