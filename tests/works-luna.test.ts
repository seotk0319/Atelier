import { describe, expect, it } from 'vitest'
import { workAdapter, workReadAllowed } from '../src/main/works/adapters'
import { lunaListBody, lunaWorks, unescapeHtml } from '../src/main/works/luna'
import { createWorkTools } from '../src/main/works/tools'
import type { WorkFetch } from '../src/main/works/types'

// 페이지 모양은 2026-11-10 루나톡 공개 상세 페이지(로그인 없이 받은 HTML)의 구조를 따랐다.
const LIST = 'https://lunatalk.chat/member/mypage_api'
const FORM = 'application/x-www-form-urlencoded'
type Obj = Record<string, unknown>

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
const html = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

function page(id: string): string {
  return [
    '<!DOCTYPE html><html><head>',
    '<meta property="og:title" content="나랑 &quot;게임&quot; 할래? | LUNATALK - AI 캐릭터 채팅">',
    '</head><body>',
    '<div id="charDescriptionHost"></div>',
    '<template id="charDescriptionTemplate">',
    '  <p>소개 <b>글</b></p>',
    '</template>',
    '<section class="situationGallery"><div class="sg-cards">',
    '<div class="sg-card" data-situation-idx="0"><div class="sg-card-head">',
    '<h4 class="sg-card-title">기본 시작 메시지</h4><span class="sg-card-badge">기본</span></div>',
    '<div class="sg-bubble" data-raw="&lt;img src=&quot;https://itimg.kr/1/2/a.webp&quot;/&gt;\n*상황* &amp; 대사"></div></div>',
    '<div class="sg-card" data-situation-idx="1"><div class="sg-card-head">',
    '<h4 class="sg-card-title">밤 &#39;학교&#39;</h4></div>',
    '<div class="sg-bubble" data-raw="{img:19} 둘째"></div></div>',
    '</div></section>',
    "<script>var csrfToken = 'x';\nvar charIdx = " + id + ';</script>',
    '</body></html>'
  ].join('\n')
}

function site(): { read: WorkFetch; calls: string[] } {
  const calls: string[] = []
  const read: WorkFetch = async (url, init) => {
    if (!workReadAllowed('luna', url, init)) throw new Error('UNAPPROVED_READ_ROUTE')
    calls.push((init?.method ?? 'GET') + ' ' + url + (init?.body ? ' ' + init.body : ''))
    if (url === LIST) {
      const offset = Number(new URLSearchParams(init!.body).get('offset'))
      const rows = Array.from({ length: offset === 0 ? 20 : 3 }, (_, i) => ({
        idx: 1000 + offset + i,
        char_name: '작품 ' + (offset + i),
        char_public: i % 2 ? 'public' : 'private',
        char_datetime: '2026-10-01 10:00:00'
      }))
      return ok({ success: true, characters: rows, has_more: offset === 0 })
    }
    const id = /\/character\/detail\/(\d+)$/.exec(url)?.[1]
    if (id === '1')
      return html(
        "<script>alert('로그인이 필요합니다.');</script><script>window.location.href = '/login';</script>"
      )
    if (id === '2')
      return html(
        "<script>alert('캐릭터를 찾을 수 없습니다.');</script><script>window.location.href = '/';</script>"
      )
    if (id) return html(page(id))
    return new Response('no', { status: 404 })
  }
  return { read, calls }
}

function tools(read: WorkFetch): (name: string, args?: Obj) => Promise<Obj> {
  const all = createWorkTools({
    reader: () => read,
    writer: () => async () => {
      throw new Error('루나는 쓰지 않는다')
    },
    sender: () => async () => {
      throw new Error('루나는 쓰지 않는다')
    },
    snapshot: async () => 'C:/snap.json',
    readFile: async () => '',
    readBinary: async () => new Uint8Array(),
    listFolder: async () => []
  })
  return (name, args = {}) => all.find((t) => t.name === name)!.run(args) as Promise<Obj>
}

describe('루나톡 작품', () => {
  it('허용 주소: 상세 페이지 GET과 내 작품 목록 POST(그 본문 모양 하나)뿐이다', () => {
    const post = (body: string, contentType = FORM): boolean =>
      workReadAllowed('luna', LIST, { method: 'POST', body, contentType })
    expect(workReadAllowed('luna', 'https://lunatalk.chat/character/detail/73535')).toBe(true)
    expect(workReadAllowed('luna', 'https://lunatalk.chat/character/detail/73535?x=1')).toBe(false)
    expect(workReadAllowed('luna', 'https://lunatalk.chat/character/edit')).toBe(false)
    expect(workReadAllowed('luna', 'https://lunatalk.chat/character/api')).toBe(false)
    expect(workReadAllowed('luna', LIST)).toBe(false)
    expect(post(lunaListBody(40))).toBe(true)
    expect(post(lunaListBody(40), 'application/json')).toBe(false)
    expect(post(lunaListBody(0).replace('my_characters', 'delete_character'))).toBe(false)
    expect(post(lunaListBody(0) + '&idx=1')).toBe(false)
    expect(post(lunaListBody(0) + '&action=x')).toBe(false)
    expect(post(lunaListBody(0).replace('limit=20', 'limit=500'))).toBe(false)
    expect(
      workReadAllowed('luna', 'https://lunatalk.chat/character/api', {
        method: 'POST',
        body: lunaListBody(0),
        contentType: FORM
      })
    ).toBe(false)
    // GET에 본문을 실을 수 없다
    expect(
      workReadAllowed('luna', 'https://lunatalk.chat/character/detail/1', { body: 'a=1' })
    ).toBe(false)
    for (const name of ['루나', '루나톡', 'lunatalk', 'LUNA'])
      expect(workAdapter(name).id).toBe('luna')
  })

  it('목록: 폼 요청으로 20개씩 넘겨 받는다', async () => {
    const s = site()
    const works = await lunaWorks.list(s.read)
    expect(works).toHaveLength(23)
    expect(works[1]).toEqual({
      id: '1001',
      title: '작품 1',
      visibility: 'public',
      status: null,
      updatedAt: '2026-10-01 10:00:00',
      characters: null
    })
    expect(s.calls).toEqual([
      'POST ' + LIST + ' ' + lunaListBody(0),
      'POST ' + LIST + ' ' + lunaListBody(20)
    ])
  })

  it('읽기: 상세 페이지의 제목·소개·시작 상황을 옮긴다 (메인·로어북은 없다)', async () => {
    const run = tools(site().read)
    const out = await run('work_read', { site: 'luna', work_id: '73535', fields: ['description'] })
    expect(out).toMatchObject({
      title: '나랑 "게임" 할래?',
      content: { description: '<p>소개 <b>글</b></p>' },
      lorebook: [],
      characters: []
    })
    const starts = out.start_scenarios as Obj[]
    expect(starts.map((s) => [s.title, s.is_default])).toEqual([
      ['기본 시작 메시지', true],
      ["밤 '학교'", false]
    ])
    const raw = await lunaWorks.readRaw(site().read, '73535')
    expect(lunaWorks.normalize(raw).startScenarios[0].content).toBe(
      '<img src="https://itimg.kr/1/2/a.webp"/>\n*상황* & 대사'
    )
    expect('main' in lunaWorks.normalize(raw).fields).toBe(false)
    // 세션 CSRF 토큰은 스냅샷에 남기지 않는다
    expect((raw as { html: string }).html).toContain("var csrfToken = '(removed)'")
    await expect(lunaWorks.readRaw(site().read, '1')).rejects.toThrow('LOGIN_REQUIRED')
    await expect(lunaWorks.readRaw(site().read, '2')).rejects.toThrow('WORK_NOT_FOUND')
    await expect(lunaWorks.readRaw(site().read, 'abc')).rejects.toThrow('BAD_WORK_ID')
  })

  it('편집기 코드를 확인하지 못한 기능은 분명한 오류로 막는다', async () => {
    const run = tools(site().read)
    const sites = (await run('sites_list')).sites as Obj[]
    expect(sites.find((s) => s.site === 'luna')).toMatchObject({
      capabilities: ['works_list', 'work_read', 'start_scenarios'],
      visibilities: [],
      can_delete: false,
      can_create: false,
      can_images: false,
      can_cover: false
    })
    await expect(
      run('work_plan', { site: 'luna', work_id: '73535', fields: { title: 'x' } })
    ).rejects.toThrow('NO_SAVE')
    await expect(run('work_delete_plan', { site: 'luna', work_id: '73535' })).rejects.toThrow(
      'NO_DELETE'
    )
    await expect(run('images_list', { site: 'luna', work_id: '73535' })).rejects.toThrow(
      'NO_IMAGES'
    )
  })

  it('문자 참조 풀기', () => {
    expect(unescapeHtml('&lt;a&gt; &amp;amp; &#44277; &#x1F600; &unknown;')).toBe(
      '<a> &amp; 공 😀 &unknown;'
    )
  })
})
