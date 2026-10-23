import { describe, expect, it } from 'vitest'
import {
  firebaseUid,
  isoDate,
  myWorksReadAllowed,
  readMyWorks,
  type WorkRead
} from '../src/main/notifications/direct/my-works'
import { workCopyText, workDate, workGroupCopyText } from '../src/shared/inbox-works'

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

/** URL 앞부분 → 응답. 요청 기록도 남긴다 */
function fake(routes: [RegExp, (url: string, body?: string) => unknown][]): {
  read: WorkRead
  calls: string[]
} {
  const calls: string[] = []
  const read: WorkRead = async (url, init) => {
    calls.push((init?.method ?? 'GET') + ' ' + url + (init?.body ? ' ' + init.body : ''))
    for (const [re, fn] of routes) if (re.test(url)) return ok(fn(url, init?.body))
    return new Response('not found', { status: 404 })
  }
  return { read, calls }
}

describe('내 작품 읽기', () => {
  it('에덴: 내 번호로 쪽을 넘기며 읽고 최초 공개일을 쓴다', async () => {
    const uid = 'ef0e1b0e-dd33-4f1a-9c89-2a6e7377ecd5'
    const page = (n: number, count: number): unknown => ({
      works: Array.from({ length: count }, (_, i) => ({
        id: 'w' + n + '-' + i,
        title: '작품 ' + n + '-' + i,
        visibility: 'public',
        created_at: '2026-10-17T03:47:19.664Z',
        first_published_at: i === 0 ? '2026-10-17T04:53:42.272Z' : null
      }))
    })
    const { read, calls } = fake([
      [/\/api\/user\/profile$/, () => ({ success: true, item: { id: uid } })],
      [/works\?page=1/, () => page(1, 24)],
      [/works\?page=2/, () => page(2, 3)]
    ])
    const works = await readMyWorks('eden', read)
    expect(works).toHaveLength(27)
    expect(calls.filter((c) => c.includes('/works?'))).toHaveLength(2)
    const first = works.find((w) => w.id === 'w1-0')!
    expect(first.atKind).toBe('published')
    expect(first.at).toBe('2026-10-17T04:53:42.272Z')
    expect(first.url).toBe('https://www.eden-chat.com/works/w1-0')
    expect(works.find((w) => w.id === 'w1-1')!.atKind).toBe('created')
  })

  it('젠잇: 다른 작가 작품이 섞여 와도 내 작품만 남긴다', async () => {
    const me = 'b7b0c83d-e151-43b8-80d9-1510c319bced'
    const { read } = fake([
      [/auth\/user/, () => ({ id: me })],
      [
        /characters\/\?page=1/,
        () => ({
          next: null,
          results: [
            { id: 'a', name: '내 작품', creator_id: me, published_at: '2026-08-10T00:11:18+09:00' },
            {
              id: 'b',
              name: '남의 작품',
              creator_id: 'other',
              published_at: '2026-08-14T20:05:00+09:00'
            }
          ]
        })
      ]
    ])
    const works = await readMyWorks('genit', read)
    expect(works.map((w) => w.id)).toEqual(['a'])
    expect(works[0].url).toBe('https://genit.ai/ko/contents/a')
    expect(workDate(works[0].at)).toBe('08/10')
  })

  it('크랙: nextCursor로 끝까지 넘긴다', async () => {
    const { read, calls } = fake([
      [
        /stories\/me\?cursor=c2/,
        () => ({
          data: {
            stories: [
              {
                _id: 'b'.repeat(24),
                name: '둘',
                createdAt: '2026-06-11T00:05:39Z',
                visibility: 'public'
              }
            ],
            nextCursor: null
          }
        })
      ],
      [
        /stories\/me$/,
        () => ({
          data: {
            stories: [
              {
                _id: 'a'.repeat(24),
                name: '하나',
                createdAt: '2026-10-16T11:50:21Z',
                visibility: 'public'
              }
            ],
            nextCursor: 'c2'
          }
        })
      ]
    ])
    const works = await readMyWorks('crack', read)
    expect(works.map((w) => w.title)).toEqual(['하나', '둘'])
    expect(calls).toHaveLength(2)
    expect(works[0].url).toBe('https://crack.wrtn.ai/detail/' + 'a'.repeat(24))
  })

  it('루나: 시간대 없는 등록 시각을 한국 시각으로 읽는다', async () => {
    const { read, calls } = fake([
      [
        /mypage_api/,
        () => ({
          success: true,
          has_more: false,
          characters: [
            {
              idx: 73834,
              char_name: '대나무숲',
              char_public: 'public',
              char_datetime: '2026-10-14 21:49:33',
              img_main: '/public/a.webp'
            }
          ]
        })
      ]
    ])
    const [w] = await readMyWorks('luna', read)
    expect(w.at).toBe('2026-10-14T12:49:33.000Z')
    expect(workDate(w.at)).toBe('10/14')
    expect(w.url).toBe('https://lunatalk.chat/character/detail/73834')
    expect(w.image).toBe('https://lunatalk.chat/public/a.webp')
    expect(calls[0]).toContain('POST https://lunatalk.chat/member/mypage_api action=my_characters')
  })

  it('티팟: 성인·일반 두 번 묻고 공개 시각을 쓴다', async () => {
    const doc = (id: string, name: string, pub: string): unknown => ({
      document: {
        name: 'projects/x/databases/(default)/documents/OC/' + id,
        fields: {
          char_name: { stringValue: name },
          time_published: { timestampValue: pub },
          time_created: { timestampValue: pub }
        }
      }
    })
    const { read, calls } = fake([
      [
        /runQuery/,
        (_u, body) =>
          String(body).includes(
            '"booleanValue":true}}},{"fieldFilter":{"field":{"fieldPath":"creator_uid"'
          )
            ? [doc('n1', '성인', '2026-10-23T04:57:44Z')]
            : [doc('s1', '일반', '2026-08-03T10:27:17Z')]
      ]
    ])
    const works = await readMyWorks('teapot', read, { teapotUid: 'nqyBkiiRFRdyAOJBBhOSjzIJWov2' })
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.includes('nqyBkiiRFRdyAOJBBhOSjzIJWov2'))).toBe(true)
    expect(works.map((w) => w.id).sort()).toEqual(['n1', 's1'])
    expect(works.find((w) => w.id === 'n1')!.url).toBe('https://teapotchat.com/character/n1')
  })

  it('로그인이 풀리면 LOGIN_REQUIRED', async () => {
    const read: WorkRead = async () => new Response('', { status: 401 })
    await expect(readMyWorks('babe', read)).rejects.toThrow('LOGIN_REQUIRED')
  })
})

describe('읽기 주소 제한', () => {
  it('그 플랫폼 주소만 허용한다', () => {
    expect(myWorksReadAllowed('eden', 'https://www.eden-chat.com/api/user/profile')).toBe(true)
    expect(myWorksReadAllowed('eden', 'https://evil.example/api')).toBe(false)
    expect(myWorksReadAllowed('eden', 'https://user:pw@www.eden-chat.com/x')).toBe(false)
    expect(myWorksReadAllowed('rplay', 'https://chat-api.rplay.live/story-chat/x')).toBe(true)
    expect(myWorksReadAllowed('babe', 'https://chat-api.rplay.live/x')).toBe(false)
  })
  it('파이어베이스 토큰에서 사용자 번호만 꺼낸다', () => {
    const payload = Buffer.from(
      JSON.stringify({ user_id: 'nqyBkiiRFRdyAOJBBhOSjzIJWov2' })
    ).toString('base64url')
    expect(firebaseUid('Bearer x.' + payload + '.y')).toBe('nqyBkiiRFRdyAOJBBhOSjzIJWov2')
    expect(firebaseUid('')).toBeNull()
  })
  it('날짜 읽기', () => {
    expect(isoDate('2026-08-10T00:11:18.092414+09:00')).toBe('2026-08-09T15:11:18.092Z')
    expect(isoDate('없음')).toBeNull()
  })
})

describe('복사 문구', () => {
  const eden = {
    platform: 'eden',
    id: 'a',
    title: 't',
    url: 'https://www.eden-chat.com/works/a',
    at: '2026-10-17T04:53:42Z',
    atKind: 'published' as const,
    isPublic: true,
    image: null
  }
  const genit = {
    ...eden,
    platform: 'genit',
    url: 'https://genit.ai/ko/contents/b',
    at: '2026-08-09T15:11:18Z'
  }
  it('플랫폼 하나', () => {
    expect(workCopyText(eden)).toBe(
      '이식 플랫폼 : 에덴\n업로드(최초공개일) 일자 : 10/17\n\n에덴: https://www.eden-chat.com/works/a'
    )
  })
  it('작품 전체는 빈 줄로 잇는다', () => {
    expect(workGroupCopyText([genit, eden]).split('\n\n')).toHaveLength(4)
    expect(workGroupCopyText([genit])).toContain('일자 : 08/10')
  })
  it('자정 직후는 한국 날짜로', () => {
    expect(workDate('2026-10-16T15:30:00Z')).toBe('10/17')
  })
})
