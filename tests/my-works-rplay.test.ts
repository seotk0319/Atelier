import { describe, expect, it } from 'vitest'
import { readMyWorks, type WorkRead } from '../src/main/notifications/direct/my-works'

describe('알플레이 내 작품', () => {
  it('내 스토리챗 번호를 받고 공개 상세에서 제목·공개일을 읽는다', async () => {
    const me = '69929db9c72ebfbb80f39501'
    const a = 'a'.repeat(24)
    const b = 'b'.repeat(24)
    const calls: string[] = []
    const read: WorkRead = async (url) => {
      calls.push(url)
      const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200 })
      if (url.includes('/account/getuser')) return json({ _id: me })
      if (url.includes('all-content-oids'))
        return json({ creatorOid: me, contentsByType: { storyChats: [a, { _id: b }, 'bad'] } })
      if (url.includes('contentOid=' + a))
        return json({
          title: '용사 추락 보고서',
          multiLangTitle: { ko: '용사 추락 보고서' },
          status: 'published',
          publishedAt: '2026-06-07T08:42:36.412Z',
          isPrivate: false
        })
      if (url.includes('contentOid=' + b))
        return json({ title: '임시', status: 'draft', createdAt: '2026-07-01T00:00:00Z' })
      return new Response('', { status: 404 })
    }
    const works = await readMyWorks('rplay', read, { rplayOid: me })
    expect(calls[0]).toContain('/account/getuser?userOid=' + me)
    const pub = works.find((w) => w.id === a)!
    expect(pub.title).toBe('용사 추락 보고서')
    expect(pub.atKind).toBe('published')
    expect(pub.url).toBe('https://rplay.live/story/' + a)
    const draft = works.find((w) => w.id === b)!
    expect(draft.isPublic).toBe(false)
    expect(draft.atKind).toBe('created')
    expect(works).toHaveLength(2)
  })
  it('계정 번호가 없으면 로그인 필요', async () => {
    await expect(readMyWorks('rplay', async () => new Response('{}'), {})).rejects.toThrow(
      'LOGIN_REQUIRED'
    )
  })
})
