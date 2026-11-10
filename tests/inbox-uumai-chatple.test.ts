import { describe, expect, it } from 'vitest'
import { normalize } from '../src/main/notifications/core/api/model.mjs'
import {
  collectPages,
  endpoints,
  readError,
  readRoute,
  renewable
} from '../src/main/notifications/core/api/client.mjs'
import { profileUpdate, safeSessionSummary } from '../src/main/notifications/core/api/sessions.mjs'
import { renewSession, renewalRecord } from '../src/main/notifications/core/api/renewal.mjs'
import { readMyWorks } from '../src/main/notifications/direct/my-works'
import {
  COOKIE_DOMAINS,
  SITES,
  captureComplete,
  hostBelongs,
  sessionReady
} from '../src/main/notifications/direct/platforms'

// 응답 모양은 2026-11-10 각 사이트 공개 스크립트에서 읽은 필드를 따른다 (실제 계정 호출 전).
// 우마이 알림: GET /v1/me/notification → {data:[{id,type,isRead,nickname,profileImage,content,linkUrl,createdAt}], meta:{next}}
// 챗플 알림: GET /v1/alarm/list?category=member&page&rows → {result:{list:[{idx,flag_type,title,content,reg_dt,type_str,link}], total_cnt}}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('우마이·챗플 알림 — 로그인 연결', () => {
  it('로그인 창 주소·쿠키 도메인·완료 조건', () => {
    expect(SITES.uumai).toBe('https://uumm.ai/notices')
    expect(SITES.chatple).toBe('https://ko.chatple.live/notification')
    expect(COOKIE_DOMAINS.uumai).toEqual(['uumm.ai'])
    expect(hostBelongs('uumai', 'https://api.uumm.ai/v1/me')).toBe(true)
    expect(hostBelongs('chatple', 'https://api.chatple.live/v1/login/me')).toBe(true)
    expect(hostBelongs('chatple', 'https://chatple.novelpia.com/')).toBe(false)
    // 우마이는 Bearer, 챗플은 Login-At 헤더가 잡혀야 끝난다. 연장 기록은 헤더를 잡을 때 같이 생긴다
    const uumai = profileUpdate('uumai', {
      origin: 'https://api.uumm.ai',
      url: 'https://api.uumm.ai/v1/me',
      headers: { authorization: 'Bearer test-only', cookie: 'no' }
    })
    expect(uumai.renewal).toMatchObject({ kind: 'uumai', jar: true })
    expect(uumai.renewal.refreshToken).toBeUndefined()
    expect(uumai.routes).toEqual({})
    expect(captureComplete('uumai', uumai)).toBe(true)
    expect(sessionReady('uumai', { headers: {} })).toBe(false)
    const chatple = profileUpdate('chatple', {
      origin: 'https://api.chatple.live',
      url: 'https://api.chatple.live/v1/alarm/list?category=member&page=2&rows=20',
      headers: { 'login-at': 'test-only-login-at' }
    })
    expect(chatple.headers['login-at']).toBe('test-only-login-at')
    expect(chatple.renewal).toMatchObject({ kind: 'chatple', jar: true })
    // 페이지가 넘긴 쪽 주소는 남기지 않는다 (늘 첫 쪽부터)
    expect(chatple.routes).toEqual({})
    expect(captureComplete('chatple', chatple)).toBe(true)
    expect(sessionReady('chatple', chatple)).toBe(true)
    const summary = safeSessionSummary(chatple)
    expect(summary.hasAuthorization).toBe(true)
    expect(JSON.stringify(summary)).not.toContain('test-only')
    expect(() =>
      profileUpdate('chatple', { origin: 'https://api-chatple.novelpia.com', headers: {} })
    ).toThrow('UNAPPROVED')
  })

  it('연장은 사이트 쿠키로만 한다 (우마이 POST, 챗플 GET → Login-At)', async () => {
    expect(() => renewalRecord('uumai', { kind: 'chatple' })).toThrow('UNAPPROVED_RENEWAL_KIND')
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return url.includes('uumm')
        ? json({ accessToken: 'new-uumai' })
        : json({ statusCode: 200, result: { LOGINAT: 'new-chatple' } })
    }) as typeof fetch
    const u = await renewSession({
      platform: 'uumai',
      profile: {
        headersByOrigin: { 'https://api.uumm.ai': { authorization: 'Bearer old' } },
        renewal: { kind: 'uumai', jar: true }
      },
      fetchImpl
    })
    expect(u).toMatchObject({ authorization: 'Bearer new-uumai', header: 'authorization' })
    expect(calls[0].url).toBe('https://api.uumm.ai/v1/auth/refresh')
    expect(calls[0].init).toMatchObject({ method: 'POST', credentials: 'include' })
    const c = await renewSession({
      platform: 'chatple',
      profile: { renewal: { kind: 'chatple', jar: true } },
      fetchImpl
    })
    expect(c).toMatchObject({ authorization: 'new-chatple', header: 'login-at' })
    expect(c.origins).toEqual(['https://api.chatple.live'])
    expect(calls[1].url).toBe('https://api.chatple.live/v1/login/refresh')
    expect(calls[1].init).toMatchObject({ method: 'GET', credentials: 'include' })
  })

  it('챗플 만료 응답(AUTH_ERROR 0001·0004)은 상태 코드와 상관없이 연장·로그인 만료로 본다', async () => {
    const expired = json({ statusCode: 400, result: { name: 'AUTH_ERROR', code: '0001' } }, 400)
    expect(await renewable(expired)).toBe(true)
    expect((await readError('chatple', expired, endpoints.chatple, 'list')).name).toBe(
      'SessionExpired'
    )
    const other = json({ statusCode: 400, result: { name: 'AUTH_ERROR', code: '0009' } }, 400)
    expect(await renewable(other)).toBe(false)
  })
})

describe('우마이·챗플 알림 — 모아보기', () => {
  it('우마이 알림을 공통 모양으로 옮긴다', () => {
    const batch = normalize('uumai', {
      data: [
        {
          id: 7,
          type: 3,
          isRead: false,
          nickname: '독자',
          content: '재밌어요',
          linkUrl: '/works/019f70d3-98e9-7681-a519-e5c483e49c29?comment=1',
          createdAt: '2026-11-10T01:00:00Z'
        },
        { id: 8, type: 1, isRead: true, content: '점검 안내', createdAt: '2026-11-09T01:00:00Z' },
        { id: 9, type: 11, isRead: true, content: '업적', linkUrl: 'https://evil.example/x' }
      ],
      meta: { next: 'n2' }
    })
    const [comment, notice, other] = batch.items as Record<string, unknown>[]
    expect(comment).toMatchObject({
      event: 'comment',
      title: '독자',
      body: '재밌어요',
      unread: true,
      at: '2026-11-10T01:00:00.000Z',
      work: {
        id: '019f70d3-98e9-7681-a519-e5c483e49c29',
        url: 'https://uumm.ai/works/019f70d3-98e9-7681-a519-e5c483e49c29'
      }
    })
    expect(comment.url).toBe('https://uumm.ai/works/019f70d3-98e9-7681-a519-e5c483e49c29?comment=1')
    expect(notice).toMatchObject({ event: 'admin', title: '우마이 공지', unread: false })
    expect(other.event).toBe('other')
    expect(other.url).toBeNull()
  })

  it('챗플 알림을 공통 모양으로 옮긴다 (한국 시각, HTML 본문, 콘텐츠 링크)', () => {
    const batch = normalize('chatple', {
      list: [
        {
          idx: 101,
          flag_type: 2,
          type_str: 'comment_reply',
          title: '답글이 달렸어요',
          content: '<b>독자</b>님이&nbsp;답글',
          reg_dt: '2026-11-10 19:44:22',
          link: '/content/321?tab=comment'
        },
        { idx: 102, flag_type: 0, title: '공지', content: '점검', reg_dt: '2026-11-09 09:00:00' },
        { idx: 103, flag_type: 2, type_str: 'activity_alarm', title: '활동' }
      ]
    })
    const [reply, notice, other] = batch.items as Record<string, unknown>[]
    expect(reply).toMatchObject({
      event: 'reply',
      title: '답글이 달렸어요',
      body: '독자 님이 답글',
      at: '2026-11-10T10:44:22.000Z',
      unread: null,
      work: { id: '321', url: 'https://ko.chatple.live/content/321' },
      url: 'https://ko.chatple.live/content/321?tab=comment'
    })
    expect(notice).toMatchObject({ event: 'admin', sourceType: 'flag_type:0' })
    expect(other).toMatchObject({ event: 'other' })
    expect(batch.unmapped).toBe(1)
  })

  it('쪽 넘기기: 우마이는 meta.next, 챗플은 rows만큼 찼을 때 다음 쪽', async () => {
    expect(readRoute('uumai', endpoints.uumai)).toBe('https://api.uumm.ai/v1/me/notification')
    const seen: string[] = []
    const rows = (n: number, from: number): unknown[] =>
      Array.from({ length: n }, (_, i) => ({ idx: from + i, flag_type: 2, type_str: 'like' }))
    const transport = async ({ url }: { url: string }): Promise<Response> => {
      seen.push(url)
      if (url.startsWith('https://api.uumm.ai'))
        return json(
          url.includes('after=')
            ? { data: [{ id: 2, type: 7 }], meta: { next: null } }
            : { data: [{ id: 1, type: 7 }], meta: { next: 'c2' } }
        )
      return json({
        statusCode: 200,
        result: { list: url.includes('page=1') ? rows(20, 1) : rows(3, 21) }
      })
    }
    const commits: number[] = []
    const commit = async (b: { items: unknown[] }): Promise<void> => {
      commits.push(b.items.length)
    }
    await collectPages({ platform: 'uumai', transport, commit })
    await collectPages({ platform: 'chatple', transport, commit })
    expect(seen).toEqual([
      'https://api.uumm.ai/v1/me/notification',
      'https://api.uumm.ai/v1/me/notification?after=c2',
      'https://api.chatple.live/v1/alarm/list?category=member&page=1&rows=20',
      'https://api.chatple.live/v1/alarm/list?category=member&page=2&rows=20'
    ])
    expect(commits).toEqual([1, 1, 20, 3])
  })
})

describe('우마이·챗플 내 작품 목록', () => {
  it('우마이: 정렬 고정, 다음 표시로 넘기고 공개·발행일을 꺼낸다', async () => {
    const seen: string[] = []
    const works = await readMyWorks('uumai', async (url) => {
      seen.push(url)
      return json(
        url.includes('after=')
          ? {
              data: [
                { id: 'b', title: '초안', publishStatus: 2, draftSavedAt: '2026-11-02T00:00:00Z' }
              ],
              meta: {}
            }
          : {
              data: [
                {
                  id: 'a',
                  title: '공개작',
                  publishStatus: 1,
                  publishedAt: '2026-10-01T00:00:00Z',
                  thumbnail: 'https://img.uumm.ai/a.webp'
                }
              ],
              meta: { next: 'x' }
            }
      )
    })
    expect(seen).toEqual([
      'https://api.uumm.ai/v1/creator/work?sort=latest',
      'https://api.uumm.ai/v1/creator/work?sort=latest&after=x'
    ])
    expect(works.map((w) => [w.id, w.isPublic, w.atKind, w.url])).toEqual([
      ['b', false, 'created', 'https://uumm.ai/works/b'],
      ['a', true, 'published', 'https://uumm.ai/works/a']
    ])
  })

  it('챗플: 계정 번호로 제작 목록을 읽는다 (영상 대표 이미지는 포스터)', async () => {
    const works = await readMyWorks('chatple', async (url) => {
      if (url === 'https://api.chatple.live/v1/login/me')
        return json({ result: { login: { mem_no: 77 } } })
      if (url === 'https://api.chatple.live/v1/contents/creator/77')
        return json({
          result: {
            contents: [
              {
                idx: 321,
                title: '공개작',
                flag_use: 0,
                flag_public: 1,
                reg_dt: '2026-11-01 10:00:00',
                avatar_url: 'https://pub-cdn.chatple.live/a.mp4',
                poster_url: '//images.novelpia.com/p.jpg'
              },
              { idx: 322, title: '비공개', flag_use: 1, reg_dt: '2026-11-02 10:00:00' }
            ]
          }
        })
      return json({}, 404)
    })
    expect(works.map((w) => [w.id, w.isPublic, w.at, w.image])).toEqual([
      ['322', false, '2026-11-02T01:00:00.000Z', null],
      ['321', true, '2026-11-01T01:00:00.000Z', 'https://images.novelpia.com/p.jpg']
    ])
    await expect(
      readMyWorks('chatple', async () => json({ result: { login: {} } }))
    ).rejects.toThrow('LOGIN_REQUIRED')
  })
})
