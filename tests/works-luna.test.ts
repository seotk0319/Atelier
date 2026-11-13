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

// 상세 페이지 머리 칸(표지·대화 수·좋아요·날짜·태그·이미지팩). 값은 지어낸 것이다.
function header(chat = '1,234', tagItems = ['남성향', '로맨스', 'R-19'], heart = '5'): string {
  const tag = (t: string): string =>
    `<li onclick="document.location = '/character/genre?sort=latest&order=desc&tags=${t}';" style="cursor:pointer;">${t}</li>`
  return [
    '<div class="lImgWrap">\n<div class="lImg">\n  <img src="/public/uploads/character/2026/01/main_x.jpg" alt="t">\n</div></div>',
    `<div class="lData"><div class="lChat"><span>${chat}</span></div><div class="lHeart"><span>${heart}</span></div></div>`,
    '<ul class="detailDate">',
    '<li>\n<p class="dTit">등록일</p>\n<p class="dDate">2026.01.02</p>\n</li>',
    '<li>\n<p class="dTit">수정일</p>\n<p class="dDate">2026.03.04</p>\n</li>',
    '</ul>',
    `<ul class="lTag">\n${tagItems.map(tag).join('\n')}\n</ul>`,
    '<ul class="detailImgpack"><li><p class="dIcon"></p>\n<p class="dTxt">24개의 이미지팩</p></li></ul>'
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
    if (id === '3')
      return html(
        "<script>alert('성인 인증이 필요한 작품입니다.');</script><script>window.location.href = '/';</script>"
      )
    if (id === '4') return html("<script>window.location.href = '/';</script>")
    if (id === '7') return html(page(id).replace('</body>', header() + '</body>'))
    if (id === '8')
      return html(page(id).replace('</body>', header('9,999', undefined, '4,321') + '</body>'))
    if (id === '10')
      return html(
        "<script>alert('삭제된 캐릭터입니다.');</script><script>window.location.href = '/';</script>"
      )
    if (id === '11')
      return html(
        "<script>alert('존재하지 않는 캐릭터입니다.');</script><script>window.location.href = '/';</script>"
      )
    // 경고 문구에 로그인 말이 없어도 로그인 화면으로 보내면 로그인 문제
    if (id === '12')
      return html(
        "<script>alert('회원 전용 작품입니다.');</script><script>window.location.href = '/login?next=/character/detail/12';</script>"
      )
    if (id === '13') return html("<script>window.location.href = '/login';</script>")
    if (id === '9') {
      const long = header('1', ['가', 'x'.repeat(81)])
      return html(page(id).replace('</body>', long + '</body>'))
    }
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

  it('기능 표: 22칸이 모두 있고 메모는 40자 이내이며 sites_list가 그대로 돌려준다', async () => {
    const keys = [
      'title',
      'description',
      'main_prompt',
      'first_message',
      'start_scenarios',
      'lorebook',
      'characters',
      'example_dialogue',
      'user_persona',
      'output_rules',
      'situation_images',
      'cover',
      'tags',
      'visibility',
      'create_work',
      'delete_work',
      'versioning_review',
      'language_editions',
      'bgm_voice',
      'jsx_html',
      'model_settings',
      'comments_stats'
    ]
    const features = lunaWorks.features!
    expect(Object.keys(features).sort()).toEqual([...keys].sort())
    for (const f of Object.values(features)) expect(f.note!.length).toBeLessThanOrEqual(40)
    // 코드와 맞는 값: 읽는 것 / 못 읽는 것 / 막힌 쓰기
    expect(features.tags).toMatchObject({ site: 'yes', read: 'yes', write: 'blocked' })
    expect(features.cover).toMatchObject({ read: 'partial', write: 'blocked' })
    // 시작 상황은 제목·기본 여부·본문만 읽는다 (보조 프롬프트·대사·상황·설명은 빈 값 고정)
    expect(features.start_scenarios).toMatchObject({ read: 'partial', write: 'blocked' })
    expect(features.lorebook).toMatchObject({ read: 'no', write: 'blocked' })
    expect(features.language_editions).toMatchObject({ site: 'no', verified: 'yes' })
    const sites = (await tools(site().read)('sites_list')).sites as Obj[]
    expect(sites.find((s) => s.site === 'luna')!.features).toEqual(features)
  })

  it('읽기: 상세 페이지의 태그·성인 태그·표지 유무·이미지팩 수를 extras로, 수정일을 updated_at으로 싣는다', async () => {
    const out = await tools(site().read)('work_read', { site: 'luna', work_id: '7' })
    expect(out.extras).toEqual({
      tags: ['남성향', '로맨스', 'R-19'],
      has_r19_tag: true,
      registered_on: '2026.01.02',
      has_cover_image: true,
      image_pack_count: 24
    })
    expect(out.updated_at).toBe('2026.03.04')
    expect(out.unsupported).toEqual([
      '메인 프롬프트(세계관·인물 설정·응답 규칙)',
      '한 줄 소개',
      '로어북',
      '등장인물',
      '위키 본문',
      '공개 범위(상세 읽기)',
      '모델·엔진 설정'
    ])
    // 표지 주소·작성자·대화 수·좋아요 수는 싣지 않는다
    expect(JSON.stringify(out.extras)).not.toMatch(/uploads|1,234|chat|like/)
  })

  it('extras에는 읽을 때마다 달라지는 값이 없어 계획 전후 비교가 깨지지 않는다', async () => {
    const a = lunaWorks.normalize(await lunaWorks.readRaw(site().read, '7'))
    const b = lunaWorks.normalize(await lunaWorks.readRaw(site().read, '8'))
    // 8번은 대화 수와 좋아요 수만 다르다
    expect(JSON.stringify(a)).toContain('"registered_on"')
    expect(JSON.stringify({ ...b, id: a.id })).toBe(JSON.stringify(a))
  })

  it('extras: 구조를 못 찾은 칸은 넣지 않고, 태그가 너무 많거나 길면 개수만 싣는다', async () => {
    const plain = lunaWorks.normalize(await lunaWorks.readRaw(site().read, '73535'))
    expect(plain.extras).toBeUndefined()
    expect(plain.updatedAt).toBeNull()
    expect(plain.unsupported).toContain('로어북')
    const long = lunaWorks.normalize(await lunaWorks.readRaw(site().read, '9'))
    expect(long.extras).toMatchObject({ tag_count: 2, has_r19_tag: false })
    expect(long.extras).not.toHaveProperty('tags')
  })

  it('오류 코드: 로그인 아닌 경고와 거절은 따로 알린다', async () => {
    await expect(lunaWorks.readRaw(site().read, '1')).rejects.toThrow('LOGIN_REQUIRED')
    await expect(lunaWorks.readRaw(site().read, '2')).rejects.toThrow('WORK_NOT_FOUND')
    await expect(lunaWorks.readRaw(site().read, '3')).rejects.toThrow(
      'WORK_ACCESS_REFUSED 성인 인증이 필요한 작품입니다.'
    )
    // 경고 문구가 없으면 가릴 수 없어 지금처럼 작품 없음으로 본다
    await expect(lunaWorks.readRaw(site().read, '4')).rejects.toThrow('WORK_NOT_FOUND')
    await expect(lunaWorks.readRaw(site().read, '10')).rejects.toThrow('WORK_NOT_FOUND')
    await expect(lunaWorks.readRaw(site().read, '11')).rejects.toThrow('WORK_NOT_FOUND')
    await expect(lunaWorks.readRaw(site().read, '12')).rejects.toThrow('LOGIN_REQUIRED')
    await expect(lunaWorks.readRaw(site().read, '13')).rejects.toThrow('LOGIN_REQUIRED')

    const listing = (body: unknown, status = 200): WorkFetch =>
      async () => new Response(JSON.stringify(body), { status })
    await expect(
      lunaWorks.list(listing({ success: false, message: '로그인이 필요합니다.' }))
    ).rejects.toThrow('LOGIN_REQUIRED')
    await expect(lunaWorks.list(listing({ success: false }))).rejects.toThrow('LOGIN_REQUIRED')
    await expect(
      lunaWorks.list(listing({ success: false, message: '잠시 후 다시 시도해 주세요.' }))
    ).rejects.toThrow('LIST_REFUSED 잠시 후 다시 시도해 주세요.')
    await expect(lunaWorks.list(listing({}, 403))).rejects.toThrow('LOGIN_REQUIRED')
    // 세션 만료를 뜻하는 다른 문구도 예전처럼 로그인 안내로 간다
    for (const message of ['세션이 만료되었습니다.', '회원만 이용할 수 있습니다.'])
      await expect(lunaWorks.list(listing({ success: false, message }))).rejects.toThrow(
        'LOGIN_REQUIRED'
      )
  })

  it('문자 참조 풀기', () => {
    expect(unescapeHtml('&lt;a&gt; &amp;amp; &#44277; &#x1F600; &unknown;')).toBe(
      '<a> &amp; 공 😀 &unknown;'
    )
  })
})
