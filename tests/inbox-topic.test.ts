import { describe, expect, it } from 'vitest'
import {
  parseTopics,
  topicCandidates,
  topicHash,
  topicUserText
} from '../src/main/notifications/topic-prompt'
import { queryInbox } from '../src/main/notifications/query'
import type { InboxItem, InboxView } from '../src/shared/inbox'

const batch = [
  { id: 'a', work: '작품', text: '3번 이미지가 안 떠요' },
  { id: 'b', work: null, text: '너무 재밌어요' },
  { id: 'c', work: null, text: '수영복 장면도 넣어주세요' }
]

describe('comment topics', () => {
  it('reads the model answer, drops bad rows, keeps summaries only for action topics', () => {
    const raw =
      '```json\n[{"i":1,"t":"bug","s":"3번 이미지 안 뜸"},{"i":2,"t":"praise","s":"칭찬"},{"i":3,"t":"nope","s":"x"},{"i":9,"t":"asset","s":"y"}]\n```'
    const out = parseTopics(raw, batch)
    expect(out.get('a')).toEqual({ t: 'bug', s: '3번 이미지 안 뜸', h: topicHash(batch[0].text) })
    expect(out.get('b')).toEqual({ t: 'praise', s: null, h: topicHash(batch[1].text) })
    expect(out.has('c')).toBe(false)
    expect(out.size).toBe(2)
    expect(parseTopics('잘 모르겠어요', batch).size).toBe(0)
  })

  it('numbers comments and asks only for comments that are new or changed', () => {
    expect(topicUserText(batch)).toBe(
      '1. [작품: 작품] 3번 이미지가 안 떠요\n2. 너무 재밌어요\n3. 수영복 장면도 넣어주세요'
    )
    const items = [
      { id: 'a', event: 'comment', at: '2026-10-01T00:00:00Z', text: '같은 글', work: null },
      { id: 'b', event: 'reply', at: '2026-10-03T00:00:00Z', text: '바뀐 글', work: null },
      { id: 'c', event: 'like', at: '2026-10-04T00:00:00Z', text: '좋아요', work: null },
      { id: 'd', event: 'comment', at: '2026-10-02T00:00:00Z', text: '  ', work: null },
      {
        id: 'f',
        event: 'comment',
        at: '2026-10-06T00:00:00Z',
        text: '음란한 나의 공주님에 달린 댓글을 확인하세요',
        work: null
      },
      { id: 'g', event: 'comment', at: '2026-10-07T00:00:00Z', text: '캐릭터 댓글', work: null },
      { id: 'e', event: 'comment', at: '2026-10-05T00:00:00Z', text: '새 글', work: null }
    ]
    const stored = {
      a: { t: 'praise' as const, s: null, h: topicHash('같은 글') },
      b: { t: 'praise' as const, s: null, h: topicHash('예전 글') }
    }
    expect(topicCandidates(items, stored).map((x) => x.id)).toEqual(['e', 'b'])
  })

  it('filters and counts the inbox by topic without touching reactions', () => {
    const base = {
      sourceType: 's',
      title: 't',
      actor: { id: null, name: null },
      work: { id: null, title: null, url: null },
      unread: false,
      url: null
    }
    const items = [
      {
        ...base,
        id: '1',
        platform: 'eden',
        event: 'comment',
        body: '오류',
        at: '2026-10-01T00:00:00Z'
      },
      {
        ...base,
        id: '2',
        platform: 'eden',
        event: 'comment',
        body: '좋아요',
        at: '2026-10-02T00:00:00Z'
      },
      { ...base, id: '3', platform: 'eden', event: 'like', body: '', at: '2026-10-03T00:00:00Z' }
    ] as InboxItem[]
    const view = {
      enabled: true,
      mode: 'direct-api',
      collector: null,
      platforms: {},
      items
    } as InboxView
    const topics = {
      '1': { t: 'bug' as const, s: '고치기', h: 'x' },
      '2': { t: 'praise' as const, s: null, h: 'y' },
      '3': { t: 'bug' as const, s: 'z', h: 'z' }
    }
    const all = queryInbox(view, {}, Date.now(), undefined, {}, {}, topics)
    expect(all.topics?.bug).toBe(1)
    expect(all.topics?.praise).toBe(1)
    expect(all.items.find((i) => i.id === '3')?.topic).toBeNull()
    const bugs = queryInbox(view, { topic: 'bug' }, Date.now(), undefined, {}, {}, topics)
    expect(bugs.items.map((i) => i.id)).toEqual(['1'])
    expect(bugs.items[0].topic).toEqual({ topic: 'bug', summary: '고치기' })
  })
})
