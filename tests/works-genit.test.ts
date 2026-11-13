import { describe, expect, it } from 'vitest'
import { workAdapter, workReadAllowed, workSendRule } from '../src/main/works/adapters'
import { genitWorks } from '../src/main/works/genit'
import { genitForm } from '../src/main/works/genit-form'
import { createWorkTools } from '../src/main/works/tools'
import type {
  FormField,
  WorkFetch,
  WorkRequest,
  WorkSend,
  WorkWrite
} from '../src/main/works/types'

// 가짜 응답의 칸 이름은 2026-11-10 젠잇 편집기 공개 스크립트가 읽고 쓰는 이름을 따랐다.
const W = '11111111-2222-4333-8444-555555555555'
const ME = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const API = 'https://api.genit.ai'
const DETAIL = API + '/api/characters/' + W + '/'
type Obj = Record<string, unknown>

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const WEBP = new Uint8Array(32)
WEBP.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

function detail(): Obj {
  return {
    id: W,
    name: '시험 작품',
    description: '소개\r\n둘째 줄',
    short_intro: '한 줄 소개',
    character_prompt: '메인 프롬프트',
    publish_type: 3,
    is_adult: true,
    is_active: true,
    type: 'simulation',
    prompt_type: 'custom',
    gender: 'female',
    default_model_tiers: ['pro'],
    creator_id: ME,
    asset_cache_version: 7,
    updated_at: '2026-11-01T00:00:00Z',
    tags: [{ id: 3, type: 'preset' }],
    profile_images: [
      { id: 101, url: '/media/characters/' + W + '/profile/a.webp', filename: 'a.webp' },
      { id: 102, url: 'https://cdn.example/b.webp' }
    ],
    lorebooks: [
      {
        title: '학교',
        description: '학교 설명',
        display_description: '',
        keywords: ['학교', '교실'],
        category: '지역',
        recall_cue: '단서',
        status: '',
        is_active: true,
        is_hidden: false,
        is_pinned: true
      }
    ],
    latest_version: {
      greetings: [
        {
          id: 1,
          title: '기본',
          content: '첫 장면',
          background: '배경',
          volatility_background: '',
          sample_questions: ['안녕?'],
          description: '설명',
          cover_image: 'covers/g1.webp',
          is_active: true,
          display_order: 0
        },
        {
          id: 2,
          title: '둘째',
          content: '둘째 장면',
          background: '',
          is_active: true,
          display_order: 1
        }
      ],
      cast_members: [
        {
          id: 'c1',
          name: '해나',
          codename: 'HN',
          history: '과거',
          introduction: '소개',
          initial_journal: '',
          background: '',
          aliases: ['해'],
          keywords: [],
          profile_url: '/media/characters/' + W + '/cast/hn.webp',
          is_active: true,
          display_order: 0
        },
        { id: 'c2', name: '민수', history: '', introduction: '조연', display_order: 1 }
      ],
      info_values: [
        {
          name: '호감도',
          codename: 'LV',
          description: '',
          is_character_variable: false,
          initial_value: '0'
        },
        { name: '', codename: 'X' }
      ],
      tier_prompts: [{ tier_key: 'pro', prompt: '프로용', is_active: true }],
      use_tier_prompts: true,
      usage_guide: '안내',
      html_templates: [{ id: 't1', name: '상태', html: '<b>{{hp}}</b>' }],
      template_values_data: [{ key: 'hp', default: 10, label: '체력' }],
      images: [
        '/media/characters/' + W + '/assets/%ED%91%9C%EC%A0%95/%EC%9B%83%EC%9D%8C.webp',
        '/media/characters/' + W + '/assets/bg2.webp',
        '/media/characters/' + W + '/assets/bg10.webp'
      ]
    }
  }
}

const field = (form: FormField[], name: string): string | undefined => {
  const f = form.find((x) => x.name === name)
  return f && 'value' in f ? f.value : undefined
}
const fields = (form: FormField[], name: string): FormField[] => form.filter((x) => x.name === name)
const parsed = (form: FormField[], name: string): unknown => JSON.parse(field(form, name) ?? 'null')

/** 젠잇 흉내: 읽기는 허용 주소만, 보내기는 허용 규칙을 통과한 것만 받는다 */
function site(): {
  read: WorkFetch
  write: WorkWrite
  send: WorkSend
  data: Obj
  sent: WorkRequest[]
} {
  const state = { data: detail(), sent: [] as WorkRequest[] }
  const read: WorkFetch = async (url, init) => {
    if (!workReadAllowed('genit', url, init)) throw new Error('UNAPPROVED_READ_ROUTE')
    if (url === API + '/api/auth/user/?lang=ko') return ok({ id: ME })
    const u = new URL(url)
    if (u.pathname === '/api/characters/') {
      const page = u.searchParams.get('page')
      return ok(
        page === '1'
          ? {
              next: null,
              results: [
                { id: W, name: '시험 작품', publish_type: 3, creator_id: ME, updated_at: 'x' },
                { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '남의 작품', creator_id: W }
              ]
            }
          : { next: null, results: [] }
      )
    }
    if (url === DETAIL + '?lang=ko') return ok(state.data)
    return new Response('no', { status: 404 })
  }
  const write: WorkWrite = async () => {
    throw new Error('젠잇은 JSON 통로를 쓰지 않는다')
  }
  const send: WorkSend = async (request) => {
    workSendRule('genit', request)
    state.sent.push(request)
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    if (request.method === 'POST')
      return ok({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'x' }, 201)
    // 저장: 받은 칸을 원본에 반영하는 정도만 흉내 낸다
    const form = request.form!
    const d = state.data
    d.name = field(form, 'name')
    d.publish_type = Number(field(form, 'publish_type'))
    if (field(form, 'character_prompt') !== undefined)
      d.character_prompt = field(form, 'character_prompt')
    if (field(form, 'lorebooks') !== undefined) d.lorebooks = parsed(form, 'lorebooks')
    if (field(form, 'greetings') !== undefined)
      (d.latest_version as Obj).greetings = parsed(form, 'greetings')
    if (field(form, 'cast_members') !== undefined)
      (d.latest_version as Obj).cast_members = parsed(form, 'cast_members')
    return ok(d)
  }
  return Object.assign(state, { read, write, send })
}

function tools(s: ReturnType<typeof site>): (name: string, args?: Obj) => Promise<Obj> {
  const all = createWorkTools({
    reader: () => s.read,
    writer: () => s.write,
    sender: () => s.send,
    snapshot: async () => 'C:/snap.json',
    readFile: async () => '',
    readBinary: async () => WEBP,
    listFolder: async () => []
  })
  return (name, args = {}) => all.find((t) => t.name === name)!.run(args) as Promise<Obj>
}

describe('젠잇 작품', () => {
  it('허용 주소: 읽기 셋(계정·내 작품 목록·작품), 보내기는 저장·만들기·삭제뿐이다', () => {
    const list =
      API +
      '/api/characters/?creator=' +
      ME +
      '&creator_dashboard=true&ordering=-created_at&page=2&page_size=20&lang=ko'
    expect(workReadAllowed('genit', API + '/api/auth/user/?lang=ko')).toBe(true)
    expect(workReadAllowed('genit', list)).toBe(true)
    expect(workReadAllowed('genit', DETAIL + '?lang=ko')).toBe(true)
    expect(workReadAllowed('genit', DETAIL)).toBe(false)
    expect(workReadAllowed('genit', list + '&search=a')).toBe(false)
    expect(
      workReadAllowed('genit', list.replace('creator_dashboard=true', 'creator_dashboard=1'))
    ).toBe(false)
    expect(workReadAllowed('genit', DETAIL + 'versions/?lang=ko')).toBe(false)
    expect(workReadAllowed('genit', 'https://genit.ai/api/characters/' + W + '/?lang=ko')).toBe(
      false
    )
    // 젠잇은 POST 읽기가 없다
    expect(workReadAllowed('genit', DETAIL + '?lang=ko', { method: 'POST', body: 'a=1' })).toBe(
      false
    )

    const rule = (method: string, url: string, extra: Partial<WorkRequest> = {}): unknown => {
      try {
        return workSendRule('genit', { method, url, ...extra } as WorkRequest)
      } catch (error) {
        return (error as Error).message
      }
    }
    expect(rule('PATCH', DETAIL, { form: [] })).toMatchObject({
      auth: 'session',
      body: 'form',
      csrfCookie: { domain: 'genit.ai', name: 'wavechat_csrftoken', header: 'x-csrftoken' }
    })
    expect(rule('POST', API + '/api/characters/', { form: [] })).toMatchObject({ body: 'form' })
    expect(rule('DELETE', DETAIL)).toMatchObject({ body: 'none' })
    for (const [method, url, extra] of [
      ['PATCH', DETAIL, { json: {} }],
      ['PATCH', DETAIL + '?lang=ko', { form: [] }],
      ['PUT', DETAIL, { form: [] }],
      ['POST', DETAIL + 'deactivate/', { form: [] }],
      ['POST', API + '/api/media-files/upload/', { form: [] }],
      ['DELETE', API + '/api/characters/', {}],
      ['PATCH', DETAIL, { form: [], headers: { cookie: 'x' } }]
    ] as [string, string, Partial<WorkRequest>][])
      expect(rule(method, url, extra)).toBe('UNAPPROVED_WRITE_ROUTE')
    expect(workAdapter('젠잇').id).toBe('genit')
  })

  it('읽기: 목록은 내 작품만, 본문은 공통 이름으로 옮긴다', async () => {
    const s = site()
    const run = tools(s)
    const listed = await run('works_list', { site: 'genit' })
    expect(listed.works).toEqual([
      {
        id: W,
        title: '시험 작품',
        visibility: 'private',
        status: null,
        updatedAt: 'x',
        characters: null
      }
    ])
    const out = await run('work_read', { site: 'genit', work_id: W, fields: ['main', 'subtitle'] })
    expect(out).toMatchObject({
      title: '시험 작품',
      visibility: 'private',
      content: { main: '메인 프롬프트', subtitle: '한 줄 소개' }
    })
    expect(out.lorebook).toEqual([
      { index: 0, title: '학교', keys: '학교, 교실', mode: '지역', length: 5 }
    ])
    expect((out.start_scenarios as Obj[]).map((x) => [x.title, x.is_default])).toEqual([
      ['기본', true],
      ['둘째', false]
    ])
    expect((out.characters as Obj[]).map((c) => c.name)).toEqual(['해나', '민수'])
  })

  it('저장 본문: 기본 정보만 바뀌면 본문 묶음 없이, 에셋 주소는 늘 같이 보낸다', () => {
    const next = genitWorks.applyChanges!(detail(), {
      fields: { title: '새 제목' },
      visibility: 'link'
    })
    const form = genitForm(next, { content: false })
    expect(field(form, 'name')).toBe('새 제목')
    expect(field(form, 'name_ko')).toBe('새 제목')
    // 손대지 않은 글은 줄바꿈(CRLF)도 원본 그대로 보낸다
    expect(field(form, 'description')).toBe('소개\r\n둘째 줄')
    expect(field(form, 'publish_type')).toBe('2')
    expect(field(form, 'is_adult')).toBe('true')
    expect(field(form, 'use_submodel')).toBe('false')
    expect(fields(form, 'default_model_tiers').map((f) => ('value' in f ? f.value : ''))).toEqual([
      'pro'
    ])
    for (const name of [
      'character_prompt',
      'greetings',
      'lorebooks',
      'cast_members',
      'info_values',
      'tags'
    ])
      expect(field(form, name)).toBeUndefined()
    // 편집기처럼 이름 순(한국어 정렬, 숫자 순)으로, 캐시 번호 v와 풀어 쓴 파일 이름으로 보낸다
    expect(parsed(form, 'image_source_urls')).toEqual([
      API + '/media/characters/' + W + '/assets/%ED%91%9C%EC%A0%95/웃음.webp?v=7',
      API + '/media/characters/' + W + '/assets/bg2.webp?v=7',
      API + '/media/characters/' + W + '/assets/bg10.webp?v=7'
    ])
    expect(parsed(form, 'image_source_meta')).toEqual([
      { folder: '표정' },
      { folder: '' },
      { folder: '' }
    ])
  })

  it('저장 본문: 본문이 바뀌면 편집기처럼 본문 묶음을 통째로 보낸다', () => {
    const next = genitWorks.applyChanges!(detail(), {
      fields: { main: '새 메인' },
      lorebookAdd: [
        {
          title: '새 항목',
          keys: '가, 나',
          content: '내용',
          mode: 'keyword',
          offKeys: [],
          turnRange: null,
          offTurnRange: null
        }
      ],
      startScenariosAdd: [{ title: '셋째', content: '셋째 장면', situation: '밤' }],
      charactersAdd: [{ name: '지아', details: '소개' }]
    })
    const form = genitForm(next, { content: true })
    expect(field(form, 'character_prompt')).toBe('새 메인')
    expect(parsed(form, 'tier_prompts')).toEqual([
      { tier_key: 'pro', is_active: true, prompt: '프로용' }
    ])
    expect(field(form, 'use_tier_prompts')).toBe('true')
    expect(field(form, 'usage_guide')).toBe('안내')
    expect(parsed(form, 'template_values')).toEqual([{ key: 'hp', default: '10', label: '체력' }])
    const greetings = parsed(form, 'greetings') as Obj[]
    expect(greetings).toHaveLength(3)
    expect(greetings[0]).toMatchObject({
      title: '기본',
      title_ko: '기본',
      title_en: '기본',
      background: '배경',
      background_en: '',
      sample_questions: ['안녕?'],
      cover_image: 'covers/g1.webp',
      display_order: 0
    })
    expect(greetings[2]).toMatchObject({
      title: '셋째',
      background: '밤',
      display_order: 2,
      is_active: true
    })
    const lore = parsed(form, 'lorebooks') as Obj[]
    // 분류가 없는 새 항목은 '설정'으로, 기존 항목의 칸은 그대로
    expect(lore.map((l) => [l.title, l.category, l.keywords])).toEqual([
      ['학교', '지역', ['학교', '교실']],
      ['새 항목', '설정', ['가', '나']]
    ])
    expect(lore[0]).toMatchObject({ recall_cue: '단서', is_hidden: false, is_pinned: true })
    const cast = parsed(form, 'cast_members') as Obj[]
    expect(cast[0]).toMatchObject({
      id: 'c1',
      profile_url: '/media/characters/' + W + '/cast/hn.webp',
      display_order: 0
    })
    expect('profile_filename' in cast[0]).toBe(false)
    expect(cast[2]).toMatchObject({
      name: '지아',
      history: '',
      introduction: '소개',
      display_order: 2
    })
    // 상태 변수: 편집기가 늘 앞에 두는 시간·위치 + 이름 있는 것만
    expect((parsed(form, 'info_values') as Obj[]).map((v) => v.codename)).toEqual(['T', 'L', 'LV'])
    expect(parsed(form, 'html_templates')).toEqual([
      { id: 't1', name: '상태', html: '<b>{{hp}}</b>' }
    ])
  })

  it('고치기 규칙: 막아 둔 것은 분명한 오류로 멈춘다', () => {
    const apply = (
      changes: Parameters<NonNullable<typeof genitWorks.applyChanges>>[1],
      raw: Obj = detail()
    ): unknown => {
      try {
        genitWorks.applyChanges!(raw, changes)
        return 'ok'
      } catch (error) {
        return (error as Error).message
      }
    }
    expect(apply({ startScenariosRemove: [0] })).toBe('KEEP_DEFAULT')
    expect(apply({ charactersRemove: [0] })).toBe('KEEP_DEFAULT')
    expect(apply({ startScenariosRemove: [1] })).toBe('ok')
    expect(apply({ startScenariosAdd: [{ title: 'x', content: 'y', dialogue: '대사' }] })).toBe(
      'BAD_CHANGES'
    )
    expect(apply({ startScenariosAdd: [{ title: '제목만' }] })).toBe('BAD_CHANGES')
    expect(apply({ lorebookRemove: [0] })).toBe('LOREBOOK_EMPTY')
    expect(apply({ lorebookPatch: [{ index: 0, mode: '미설정' }] })).toBe('BAD_LOREBOOK')
    expect(apply({ lorebookPatch: [{ index: 0, mode: '인물' }] })).toBe('ok')
    expect(apply({ fields: { creator_comment: 'x' } })).toBe('BAD_FIELD')
    expect(apply({ fields: { main: '  ' } })).toBe('EMPTY_FIELD')
    expect(apply({ visibility: 'secret' })).toBe('BAD_VISIBILITY')
    expect(apply({ visibility: 'public' }, { ...detail(), publish_type: 4 })).toBe('BAD_VISIBILITY')
    // 모델별 JSON 프롬프트(옛 형식)는 메인을 고치지 않는다
    expect(
      apply(
        { fields: { main: '새' } },
        { ...detail(), character_prompt: '{"default":"a","pro":"b"}' }
      )
    ).toBe('PROMPT_SHAPE')
    // 분류가 미설정인 옛 항목은 바꾸거나 새로 더한 항목이 아니면 검사하지 않는다 (옛 값 그대로 보낸다).
    // 그 항목을 바꾸면 검사한다 (편집기 규칙)
    const unset = detail()
    ;(unset.lorebooks as Obj[])[0].category = '미설정'
    expect(apply({ fields: { main: '새' } }, unset)).toBe('ok')
    expect(apply({ fields: { title: '새' } }, unset)).toBe('ok')
    expect(apply({ lorebookPatch: [{ index: 0, title: '바꾼 제목' }] }, unset)).toBe('BAD_LOREBOOK')
    expect(apply({ lorebookPatch: [{ index: 0, title: '바꾼 제목', mode: '인물' }] }, unset)).toBe(
      'ok'
    )
  })

  it('저장: 계획 → 저장이 PATCH 파일 묶음 한 번으로 나가고 다시 읽어 견준다', async () => {
    const s = site()
    const run = tools(s)
    const plan = await run('work_plan', {
      site: 'genit',
      work_id: W,
      fields: { main: '바뀐 메인' },
      lorebook_patch: [{ index: 0, content: '고친 설명' }]
    })
    const saved = await run('work_save', { plan_id: plan.plan_id })
    expect(saved).toMatchObject({ saved: true, verified: true })
    expect(s.sent).toHaveLength(1)
    const [req] = s.sent
    expect([req.method, req.url]).toEqual(['PATCH', DETAIL])
    expect(req.headers).toMatchObject({
      origin: 'https://genit.ai',
      referer: 'https://genit.ai/',
      accept: 'application/json'
    })
    expect(field(req.form!, 'character_prompt')).toBe('바뀐 메인')
    expect((parsed(req.form!, 'lorebooks') as Obj[])[0].description).toBe('고친 설명')
  })

  it('공개 전환·삭제·새 작품', async () => {
    const s = site()
    const run = tools(s)
    // 완전 공개로 바꾸는 계획은 도구가 받지 않는다 (사용자만 하는 일). 링크 공개는 된다
    await run('work_plan', { site: 'genit', work_id: W, visibility: 'public' }).then(
      (r) => expect(r.nothing_to_save).toBe(true),
      (e: Error) => expect(e.message).toBe('PUBLIC_BY_USER')
    )
    const plan = await run('work_plan', { site: 'genit', work_id: W, visibility: 'link' })
    await run('work_save', { plan_id: plan.plan_id })
    expect(field(s.sent[0].form!, 'publish_type')).toBe('2')
    // 공개 범위만 바꾸면 본문 묶음은 보내지 않는다
    expect(field(s.sent[0].form!, 'greetings')).toBeUndefined()

    const del = await run('work_delete_plan', { site: 'genit', work_id: W })
    s.data.name = '시험 작품'
    await run('work_delete', { plan_id: del.plan_id, title: del.title }).catch(() => undefined)
    expect(s.sent.at(-1)).toMatchObject({ method: 'DELETE', url: DETAIL })

    const id = await genitWorks.create!(
      s.write,
      {
        title: '새 작품',
        main: '메인',
        adult: false,
        characters: [{ name: '주연' }],
        startScenarios: [{ title: '처음', content: '첫 장면' }],
        lorebook: [
          {
            title: '항목',
            keys: '키',
            content: '내용',
            mode: '인물',
            offKeys: [],
            turnRange: null,
            offTurnRange: null
          }
        ]
      },
      s.read,
      { read: s.read, write: s.write, send: s.send }
    )
    expect(id).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    const create = s.sent.at(-1)!
    expect([create.method, create.url]).toEqual(['POST', API + '/api/characters/'])
    expect(field(create.form!, 'publish_type')).toBe('3')
    expect(field(create.form!, 'type')).toBe('simulation')
    expect((parsed(create.form!, 'lorebooks') as Obj[])[0]).toMatchObject({
      category: '인물',
      keywords: ['키']
    })
    expect((parsed(create.form!, 'cast_members') as Obj[])[0]).toMatchObject({
      name: '주연',
      display_order: 0
    })
    expect(() =>
      genitWorks.checkDraft!({
        title: 'a',
        main: 'b',
        adult: false,
        characters: [],
        startScenarios: []
      })
    ).toThrow('BAD_DRAFT')
  })

  it('이미지: 0번 묶음은 에셋(내부 이미지), 1번은 대표 이미지. 저장 본문에 실어 보낸다', async () => {
    const groups = genitWorks.imageGroups!(detail())
    expect(groups.map((g) => [g.character, g.images.map((i) => i.label)])).toEqual([
      [0, ['표정/웃음.webp', 'bg2.webp', 'bg10.webp']],
      [1, ['a.webp', 'profile_2']]
    ])
    const file = { name: '새 그림.webp', type: 'image/webp', data: WEBP }
    expect(() => genitWorks.planImages!(detail(), { add: [{ file }] })).toThrow('BAD_IMAGE_LABEL')
    expect(() => genitWorks.planImages!(detail(), { add: [{ file, label: 'bg2' }] })).toThrow(
      'BAD_IMAGE_LABEL'
    )
    expect(() => genitWorks.planImages!(detail(), { order: [1, 0, 2] })).toThrow('BAD_CHANGES')
    expect(() => genitWorks.planImages!(detail(), { character: 1, remove: [0] })).toThrow(
      'KEEP_MAIN_IMAGE'
    )

    const s = site()
    await genitWorks.applyImages!({ read: s.read, write: s.write, send: s.send }, W, detail(), {
      add: [{ file, label: '표정/화남' }],
      remove: [1]
    })
    const form = s.sent[0].form!
    const media = fields(form, 'media_files')
    expect(media).toHaveLength(1)
    expect('file' in media[0] && media[0].file.name).toBe('화남.webp')
    expect(parsed(form, 'media_files_meta')).toEqual([{ folder: '표정', filename: '화남.webp' }])
    expect(
      (parsed(form, 'image_source_urls') as string[]).some((u) => u.includes('bg2.webp'))
    ).toBe(false)
    // 에셋이 바뀌면 편집기처럼 본문 묶음도 같이 간다
    expect(field(form, 'greetings')).toBeDefined()

    await genitWorks.applyImages!({ read: s.read, write: s.write, send: s.send }, W, detail(), {
      character: 1,
      add: [{ file: { ...file, name: 'p3.webp' } }],
      remove: [1]
    })
    const profile = s.sent[1].form!
    expect(parsed(profile, 'profile_images_meta')).toEqual([
      { file_name: 'a.webp', order: 0, existing_media_id: '101' },
      { file_name: 'p3.webp', order: 1 }
    ])
    expect(fields(profile, 'profile_image_files')).toHaveLength(1)
    expect(field(profile, 'greetings')).toBeUndefined()
  })
})

const entry = (title: string, content: string, keys: string, mode: string | null = null) => ({
  title,
  keys,
  content,
  mode,
  offKeys: [],
  turnRange: null,
  offTurnRange: null
})
/** 로어북이 둘(A: 지역·숨김 아님·단서 a / B: 인물·숨김·단서 b)인 작품 */
function twoLore(): Obj {
  const raw = detail()
  raw.lorebooks = [
    {
      title: 'A',
      description: 'A 설명',
      display_description: 'A 표시',
      keywords: ['a1'],
      category: '지역',
      recall_cue: 'cue-a',
      status: 'sa',
      is_active: true,
      is_hidden: false,
      is_pinned: false
    },
    {
      title: 'B',
      description: 'B 설명',
      display_description: 'B 표시',
      keywords: ['b1'],
      category: '인물',
      recall_cue: 'cue-b',
      status: 'sb',
      is_active: false,
      is_hidden: true,
      is_pinned: true
    }
  ]
  return raw
}
const rows = (raw: unknown): Obj[] => (raw as { lorebooks: Obj[] }).lorebooks

describe('젠잇 저장: 바꾸려던 칸만 바뀐다', () => {
  it('로어북 전체 교체는 제목으로 옛 항목을 짝짓고, 짝 없는 새 항목은 물려받지 않는다', () => {
    // 맨 앞에 새 항목을 끼우고 A·B 순서를 바꾼다. 자리로 짝지으면 새 항목이 A의 칸을, A가 B의 칸을 물려받는다.
    const next = genitWorks.applyChanges!(twoLore(), {
      lorebook: [
        entry('C', 'C 설명', 'c1'),
        entry('B', 'B 설명', 'b1', 'keyword'),
        entry('A', 'A 설명 고침', 'a1')
      ]
    })
    const [c, b, a] = rows(next)
    expect(c).toMatchObject({
      title: 'C',
      category: '설정',
      recall_cue: '',
      display_description: '',
      is_hidden: true,
      is_pinned: true
    })
    // 분류 이름이 아닌 mode(keyword)는 옛 분류를 바꾸지 않는다
    expect(b).toMatchObject({
      title: 'B',
      category: '인물',
      recall_cue: 'cue-b',
      status: 'sb',
      is_active: false,
      is_pinned: true
    })
    expect(a).toMatchObject({
      title: 'A',
      description: 'A 설명 고침',
      category: '지역',
      recall_cue: 'cue-a',
      is_hidden: false,
      is_pinned: false
    })
  })

  it('로어북 전체 교체: 같은 제목이 여럿이면 앞에서부터, 제목만 고친 항목은 같은 자리 옛 항목을 잇는다', () => {
    const raw = twoLore()
    rows(raw)[1].title = 'A'
    const same = rows(genitWorks.applyChanges!(raw, { lorebook: [entry('A', 'x', 'k'), entry('A', 'y', 'k')] }))
    expect(same.map((l) => l.recall_cue)).toEqual(['cue-a', 'cue-b'])
    const renamed = rows(
      genitWorks.applyChanges!(twoLore(), {
        lorebook: [entry('A 새 이름', 'A 설명', 'a1'), entry('B', 'B 설명', 'b1')]
      })
    )
    expect(renamed.map((l) => [l.title, l.recall_cue])).toEqual([
      ['A 새 이름', 'cue-a'],
      ['B', 'cue-b']
    ])
  })

  it('로어북 전체 교체: 분류가 없던 옛 항목에 분류를 지어 붙이지 않는다', () => {
    const raw = twoLore()
    delete rows(raw)[0].category
    const next = rows(
      genitWorks.applyChanges!(raw, {
        lorebook: [entry('A', 'A 설명', 'a1', '미설정'), entry('B', 'B 설명 고침', 'b1')]
      })
    )
    expect('category' in next[0]).toBe(false)
    expect(next[1].category).toBe('인물')
  })

  it('키워드: 읽은 글 그대로면 원본 목록(쉼표 든 키워드 포함)을 그대로 두고, 바꾸면 쉼표로 나눈다', () => {
    const raw = twoLore()
    rows(raw)[0].keywords = ['a,1', ' 둘째 ', '셋째']
    const joined = 'a,1,  둘째 , 셋째'
    const whole = rows(
      genitWorks.applyChanges!(raw, {
        lorebook: [entry('A', 'A 설명 고침', joined), entry('B', 'B 설명', 'b1')]
      })
    )
    expect(whole[0].keywords).toEqual(['a,1', ' 둘째 ', '셋째'])
    const patched = rows(
      genitWorks.applyChanges!(raw, {
        lorebookPatch: [
          { index: 0, keys: joined, content: '바뀜' },
          { index: 1, keys: 'x, y' }
        ]
      })
    )
    expect(patched[0].keywords).toEqual(['a,1', ' 둘째 ', '셋째'])
    expect(patched[1].keywords).toEqual(['x', 'y'])
  })

  it('공개 범위를 모르면 공개(1)로 보내지 않고 멈춘다', async () => {
    for (const publish of [undefined, null, '', 0, 9, 'x'])
      expect(() => genitForm({ ...detail(), publish_type: publish }, { content: false })).toThrow(
        'WORK_SHAPE publish_type'
      )
    // 작업 사본(4)은 예전처럼 공개 범위를 보내지 않는다
    const copy = genitForm({ ...detail(), publish_type: 4 }, { content: false })
    expect(field(copy, 'publish_type')).toBeUndefined()
    expect(field(genitForm({ ...detail(), publish_type: '2' }, { content: false }), 'publish_type')).toBe('2')

    // 저장·이미지 올리기 모두 요청이 나가기 전에 멈춘다
    const s = site()
    delete s.data.publish_type
    const run = tools(s)
    // 계획 단계에서 멈춘다(저장 단계까지 가서 승인된 계획이 소진되지 않게)
    await expect(
      run('work_plan', { site: 'genit', work_id: W, fields: { title: '새 제목' } })
    ).rejects.toThrow('WORK_SHAPE')
    await expect(
      genitWorks.applyImages!({ read: s.read, write: s.write, send: s.send }, W, s.data, {
        remove: [0]
      })
    ).rejects.toThrow('WORK_SHAPE')
    expect(s.sent).toHaveLength(0)
  })

  it('유형·프롬프트 종류·성별·성인 여부·활성 여부가 비어 있으면 기본값을 지어 보내지 않고 멈춘다', () => {
    for (const key of ['type', 'prompt_type', 'gender', 'is_adult', 'is_active'])
      for (const value of [undefined, null, ''])
        expect(() => genitForm({ ...detail(), [key]: value }, { content: false })).toThrow(
          'WORK_SHAPE ' + key
        )
    const form = genitForm(
      { ...detail(), gender: 'female', is_adult: false, is_active: false },
      { content: false }
    )
    expect([field(form, 'gender'), field(form, 'is_adult'), field(form, 'is_active')]).toEqual([
      'female',
      'false',
      'false'
    ])
  })

  it('본문 묶음: 로어북 칸은 원본에 있으면 그 값 그대로(is_pinned false 유지), 없는 칸만 기본값', () => {
    const raw = twoLore()
    delete rows(raw)[0].category
    delete rows(raw)[0].is_hidden
    const next = genitWorks.applyChanges!(raw, { fields: { main: '새 메인' } })
    const sent = parsed(genitForm(next, { content: true }), 'lorebooks') as Obj[]
    // 원본에 칸이 없는 옛 항목은 지금까지 실제 저장에 쓰인 기본값으로 채운다 (있는 값은 그대로)
    expect(sent[0]).toMatchObject({ category: '미설정', is_hidden: true })
    expect(sent[0]).toMatchObject({ is_pinned: false, is_active: true, recall_cue: 'cue-a' })
    expect(sent[1]).toMatchObject({ category: '인물', is_pinned: true, is_active: false })
  })

  it('손대지 않은 분류 미설정 로어북 때문에 막히지 않고, 새로 더한 항목은 그대로 검사한다', () => {
    const raw = twoLore()
    delete rows(raw)[0].category
    expect(() => genitWorks.applyChanges!(raw, { fields: { main: '새 메인' } })).not.toThrow()
    expect(() =>
      genitWorks.applyChanges!(raw, { lorebookAdd: [entry('C', 'C 설명', 'c1')] })
    ).not.toThrow()
    // 새로 더한 항목의 내용이 비면 막는다
    expect(() =>
      genitWorks.applyChanges!(raw, { lorebookAdd: [entry('C', '  ', 'c1')] })
    ).toThrow('BAD_LOREBOOK')
    // 옛 항목을 바꾸면서 분류를 안 채우면 막는다
    expect(() =>
      genitWorks.applyChanges!(raw, { lorebookPatch: [{ index: 0, content: '고침' }] })
    ).toThrow('BAD_LOREBOOK')
  })

  it('제목·본문이 빈 옛 시작 상황은 다른 시작 상황을 고칠 때 막지 않고 그대로 보낸다', () => {
    const raw = detail()
    ;((raw.latest_version as Obj).greetings as Obj[])[1].content = ''
    const next = genitWorks.applyChanges!(raw, { startScenarios: [{ index: 0, content: '고친 첫 장면' }] })
    const sent = parsed(genitForm(next, { content: true }), 'greetings') as Obj[]
    expect(sent.map((g) => [g.title, g.content])).toEqual([
      ['기본', '고친 첫 장면'],
      ['둘째', '']
    ])
    // 빈 옛 항목의 다른 칸을 고쳐도 안 바꾼 빈 칸 때문에 막히지 않는다 (빈 본문 그대로 간다)
    const renamed = genitWorks.applyChanges!(raw, {
      startScenarios: [{ index: 1, title: '둘째 고침' }]
    })
    const sentRenamed = parsed(genitForm(renamed, { content: true }), 'greetings') as Obj[]
    expect(sentRenamed.map((g) => [g.title, g.content])).toEqual([
      ['기본', '첫 장면'],
      ['둘째 고침', '']
    ])
    // 바꾸는 칸을 비우거나 비운 항목을 더하면 막는다
    for (const patch of [
      { index: 0, title: ' ' },
      { index: 0, content: '' }
    ])
      expect(() => genitWorks.applyChanges!(raw, { startScenarios: [patch] })).toThrow('BAD_CHANGES')
    expect(() =>
      genitWorks.applyChanges!(raw, { startScenariosAdd: [{ title: '셋째', content: ' ' }] })
    ).toThrow('BAD_CHANGES')
  })

  it('이름이 빈 옛 캐릭터와 앞뒤 공백·긴 글을 손대지 않은 채 그대로 보낸다', () => {
    const raw = detail()
    const cast = (raw.latest_version as Obj).cast_members as Obj[]
    cast[0].introduction = '  소개 앞뒤 공백 \n'
    cast[0].codename = ' HN '
    cast[0].background = 'b'.repeat(600)
    cast[1].name = ''
    delete cast[1].is_active
    const next = genitWorks.applyChanges!(raw, { fields: { main: '새 메인' } })
    const sent = parsed(genitForm(next, { content: true }), 'cast_members') as Obj[]
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ introduction: '  소개 앞뒤 공백 \n', codename: ' HN ' })
    expect((sent[0].background as string).length).toBe(600)
    expect(sent[1].name).toBe('')
    expect('is_active' in sent[1]).toBe(false)
    // 바꾸거나 더하는 캐릭터의 이름이 비면 예전처럼 막는다
    expect(() => genitWorks.applyChanges!(raw, { characters: [{ index: 0, name: ' ' }] })).toThrow('EMPTY_FIELD')
    expect(() => genitWorks.applyChanges!(raw, { charactersAdd: [{ name: ' ' }] })).toThrow('EMPTY_FIELD')
    // 이름이 빈 옛 캐릭터의 소개만 고치면 이름은 안 바꾼 칸이라 빈 채로 그대로 간다
    const edited = genitWorks.applyChanges!(raw, { characters: [{ index: 1, details: '고친 소개' }] })
    const sentEdited = parsed(genitForm(edited, { content: true }), 'cast_members') as Obj[]
    expect([sentEdited[1].name, sentEdited[1].introduction]).toEqual(['', '고친 소개'])
  })

  it('줄바꿈(CRLF)이 든 메인·시작 상황·소개를 손대지 않은 채 그대로 보낸다', () => {
    const raw = detail()
    raw.character_prompt = '메인\r\n둘째 줄'
    const v = raw.latest_version as Obj
    ;(v.greetings as Obj[])[0].content = '첫\r\n장면'
    ;(v.greetings as Obj[])[0].background = '배경\r\n둘'
    v.usage_guide = '안내\r\n둘'
    const next = genitWorks.applyChanges!(raw, { fields: { title: '새 제목' } })
    const form = genitForm(next, { content: true })
    expect(field(form, 'character_prompt')).toBe('메인\r\n둘째 줄')
    expect(field(form, 'usage_guide')).toBe('안내\r\n둘')
    expect(field(form, 'description')).toBe('소개\r\n둘째 줄')
    expect((parsed(form, 'greetings') as Obj[])[0]).toMatchObject({
      content: '첫\r\n장면',
      content_en: '첫\r\n장면',
      background: '배경\r\n둘'
    })
    // 읽을 때는 예전처럼 LF로 본다
    expect(genitWorks.normalize(raw).fields.main).toBe('메인\n둘째 줄')
  })

  it('저장 뒤 견줌: 앞뒤 공백·CRLF가 든 손대지 않은 칸 때문에 verified가 깨지지 않는다', async () => {
    const s = site()
    s.data.description = '소개\r\n둘째 줄 '
    ;((s.data.latest_version as Obj).cast_members as Obj[])[0].introduction = '소개 \n'
    ;((s.data.latest_version as Obj).greetings as Obj[])[0].content = '첫\r\n장면'
    const run = tools(s)
    const plan = await run('work_plan', { site: 'genit', work_id: W, fields: { main: '바뀐 메인' } })
    const saved = await run('work_save', { plan_id: plan.plan_id })
    expect(saved).toMatchObject({ saved: true, verified: true })
    expect(field(s.sent[0].form!, 'description')).toBe('소개\r\n둘째 줄 ')
  })
})

const FEATURE_KEYS = [
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
const PATCH_NOTE = '패치'.repeat(150)

/** 원본 칸 이름(2026-11-10·11 읽기 기록)을 따른 지어낸 값. 통계·본문·주소는 일부러 넣어 둔다 */
function rich(): Obj {
  const raw = detail()
  const v = raw.latest_version as Obj
  Object.assign(raw, {
    tags: [
      { type: 'preset', id: 't1', name: '순애', name_ko: '순애', image_url: null },
      { type: 'custom', id: 't2', name: '일상' }
    ],
    genres: ['romance'],
    description_images: [],
    likes_count: 56,
    comments_count: 15,
    usage_count: 205,
    message_count: 9085,
    media_count: 3,
    comments: [{ id: 1, content: '댓글 본문 비밀' }],
    creator_nickname: '닉네임',
    is_board_enabled: true,
    admin_private_reason: '',
    comment_ban: null,
    monetization_enabled: true,
    settlement_class: 'STANDARD',
    custom_settlement_request: { memo: '정산 비밀' },
    comment_reward_setting: { reward_amount: 100, min_characters: 10, min_usage_messages: 5 },
    version_count: 58,
    latest_patch_note_at: '2026-11-11T14:14:57+09:00',
    latest_patch_note: PATCH_NOTE,
    change_summary: '',
    age_editable: false,
    review_cover_image_url: null
  })
  ;(raw.profile_images as Obj[])[1].is_under_review = true
  Object.assign(v, { use_submodel: false, shortcuts: null })
  return raw
}

describe('젠잇 연결부: 기능 표·숨은 설정·못 읽는 칸', () => {
  it('기능 표: 22개 열쇠가 모두 있고 노트는 40자 이내 한 줄이다', async () => {
    const f = genitWorks.features!
    expect(Object.keys(f).sort()).toEqual([...FEATURE_KEYS].sort())
    for (const [key, v] of Object.entries(f)) {
      expect(v.note, key).toBeTruthy()
      expect(v.note!.length, key).toBeLessThanOrEqual(40)
      expect(v.note, key).not.toMatch(/[\r\n]/)
    }
    // 코드와 맞춘 값: 태그·버전·템플릿·모델 설정은 extras로 일부 읽고, 통계는 읽지 않는다
    expect(f.tags).toMatchObject({ site: 'yes', read: 'yes', write: 'no' })
    expect(f.versioning_review).toMatchObject({ read: 'partial', write: 'no' })
    expect(f.jsx_html).toMatchObject({ read: 'partial', write: 'no' })
    expect(f.model_settings).toMatchObject({ read: 'partial', write: 'no' })
    expect(f.comments_stats).toMatchObject({ read: 'no', write: 'no' })
    expect(f.main_prompt.write).toBe('partial')
    expect(f.create_work).toMatchObject({ read: 'no', write: 'yes' })
    const listed = (await tools(site())('sites_list')) as { sites: { site: string; features: unknown }[] }
    expect(listed.sites.find((x) => x.site === 'genit')!.features).toEqual(f)
  })

  it('extras: 원본에 있는 설정은 짧은 값 그대로, 긴 글은 글자 수, 목록은 개수로 싣는다', () => {
    const body = genitWorks.normalize(rich())
    expect(body.extras).toEqual({
      tag_count: 2,
      tags: ['순애', '일상'],
      genre_count: 1,
      genres: ['romance'],
      is_adult: true,
      work_type: 'simulation',
      target_gender: 'female',
      prompt_type: 'custom',
      default_model_tier_count: 1,
      default_model_tiers: ['pro'],
      use_tier_prompts: true,
      use_submodel: false,
      prompt_by_model: false,
      tier_prompt_count: 1,
      usage_guide_length: 2,
      html_template_count: 1,
      template_value_count: 1,
      info_value_count: 2,
      shortcut_count: 0,
      sample_question_count: 1,
      start_scenario_cover_count: 1,
      profile_image_count: 2,
      has_profile_image: true,
      profile_images_under_review_count: 1,
      description_image_count: 0,
      has_review_cover_image: false,
      version_count: 58,
      latest_patch_note_at: '2026-11-11T14:14:57+09:00',
      latest_patch_note_length: PATCH_NOTE.length,
      change_summary_length: 0,
      age_editable: false,
      has_admin_private_reason: false,
      is_board_enabled: true,
      has_comment_ban: false,
      monetization_enabled: true,
      settlement_class: 'STANDARD',
      has_custom_settlement_request: true,
      comment_reward_amount: 100,
      comment_reward_min_characters: 10,
      comment_reward_min_usage_messages: 5
    })
    // 본문·주소·계정·통계는 싣지 않는다
    const text = JSON.stringify(body.extras)
    for (const leak of ['메인 프롬프트', '소개', 'http', '/media/', ME, '닉네임', '댓글 본문', '정산 비밀', PATCH_NOTE])
      expect(text, leak).not.toContain(leak)
    for (const volatile of ['likes_count', 'comments_count', 'usage_count', 'message_count', 'media_count'])
      expect(body.extras, volatile).not.toHaveProperty(volatile)
  })

  it('extras: 원본에 없는 칸은 싣지 않고, 길거나 많은 이름은 개수만 싣는다', () => {
    expect(genitWorks.normalize({ id: W }).extras).toEqual({})
    const raw = rich()
    raw.tags = Array.from({ length: 21 }, (_, i) => ({ name: '태그' + i }))
    raw.settlement_class = 'X'.repeat(81)
    raw.genres = ['y'.repeat(81)]
    const extras = genitWorks.normalize(raw).extras!
    expect(extras.tag_count).toBe(21)
    expect(extras).not.toHaveProperty('tags')
    expect(extras.genre_count).toBe(1)
    expect(extras).not.toHaveProperty('genres')
    expect(extras).not.toHaveProperty('settlement_class')
    // 모델별 JSON 프롬프트와 옛 형식 템플릿 값 칸
    raw.character_prompt = JSON.stringify({ default: '기본', pro: '프로' })
    delete (raw.latest_version as Obj).template_values_data
    ;(raw.latest_version as Obj).template_values = [{ key: 'a' }, { key: 'b' }]
    const old = genitWorks.normalize(raw).extras!
    expect(old.prompt_by_model).toBe(true)
    expect(old.template_value_count).toBe(2)
  })

  it('extras: 읽을 때마다 달라지는 통계가 바뀌어도 같고, 공통 칸은 그대로다', async () => {
    const a = rich()
    const b = rich()
    Object.assign(b, { likes_count: 999, comments_count: 1, usage_count: 7, message_count: 3, media_count: 0 })
    const bodyA = genitWorks.normalize(a)
    const bodyB = genitWorks.normalize(b)
    expect(JSON.stringify(bodyA)).toBe(JSON.stringify(bodyB))
    const { extras, unsupported, ...common } = bodyA
    expect(extras).toBeDefined()
    expect(unsupported).toBeDefined()
    expect(common.fields).toEqual({
      title: '시험 작품',
      subtitle: '한 줄 소개',
      description: '소개\r\n둘째 줄',
      main: '메인 프롬프트'
    })
    expect(common.visibility).toBe('private')
    expect(common.status).toBe('active')
    // 계획 뒤에 통계만 바뀌어도 PLAN_STALE로 깨지지 않는다
    const s = site()
    Object.assign(s.data, rich())
    const run = tools(s)
    const plan = await run('work_plan', { site: 'genit', work_id: W, fields: { main: '바뀐 메인' } })
    Object.assign(s.data, { likes_count: 1000, usage_count: 1, message_count: 5 })
    const saved = await run('work_save', { plan_id: plan.plan_id })
    expect(saved).toMatchObject({ saved: true })
  })

  it('unsupported: 읽지 못하는 칸을 적고, extras로 읽는 태그는 넣지 않는다', () => {
    const body = genitWorks.normalize(rich())
    expect(body.unsupported).toEqual(
      expect.arrayContaining(['상태창 템플릿 내용', '상태 변수', '단축어', '모델별 프롬프트', '댓글·통계'])
    )
    expect(body.unsupported!.length).toBeGreaterThan(0)
    expect(body.unsupported!.some((u) => u.includes('태그') || u.includes('장르'))).toBe(false)
    // 호출마다 새 배열이라 바깥에서 고쳐도 연결부 상수가 바뀌지 않는다
    body.unsupported!.push('x')
    expect(genitWorks.normalize(rich()).unsupported).not.toContain('x')
  })

  it('로어북 전체 교체: given에 mode가 없으면 옛 분류를 그대로 두고, 있으면 받은 분류로 바꾼다', () => {
    const swap = (given: string[] | undefined, mode: string | null): Obj =>
      rows(
        genitWorks.applyChanges!(twoLore(), {
          lorebook: [{ ...entry('A', 'A 설명', 'a1', mode), ...(given ? { given } : {}) }]
        })
      )[0]
    // 안 줬다 → 옛 값(지역) 그대로
    expect(swap(['title', 'keys', 'content'], '세력').category).toBe('지역')
    // 줬다 → 받은 값
    expect(swap(['title', 'keys', 'content', 'mode'], '세력').category).toBe('세력')
    // given이 없는 옛 호출은 지금 동작 그대로
    expect(swap(undefined, '세력').category).toBe('세력')
    expect(swap(undefined, null).category).toBe('지역')
  })
})

describe('젠잇 저장: 손대지 않은 값 지키기 (검토 뒤 보강)', () => {
  it('로어북 전체 교체: keys를 안 주면 옛 키워드를 그대로 두고, 빈 keys를 줬으면 비운다', () => {
    const swap = (given: string[] | undefined): Obj =>
      rows(
        genitWorks.applyChanges!(twoLore(), {
          lorebook: [
            { ...entry('A', '새 설명', ''), ...(given ? { given } : {}) },
            entry('B', 'B 설명', 'b1')
          ]
        })
      )[0]
    expect(swap(['title', 'content']).keywords).toEqual(['a1'])
    expect(swap(['title', 'keys', 'content']).keywords).toEqual([])
    // given이 없는 옛 호출은 지금 동작 그대로
    expect(swap(undefined).keywords).toEqual([])
  })

  it('로어북 전체 교체: 제목이 같은 항목은 내용까지 견줘 순서를 바꿔도 제 짝의 칸을 지킨다', () => {
    const raw = twoLore()
    rows(raw)[1].title = 'A'
    const next = rows(
      genitWorks.applyChanges!(raw, {
        lorebook: [entry('A', 'B 설명', 'b1'), entry('A', 'A 설명', 'a1')]
      })
    )
    expect(next.map((l) => [l.description, l.recall_cue, l.is_active])).toEqual([
      ['B 설명', 'cue-b', false],
      ['A 설명', 'cue-a', true]
    ])
  })

  it('use_submodel은 원본 값 그대로 보내고(본문 묶음 여부와 상관없이), 모르면 false', () => {
    const on = detail()
    ;(on.latest_version as Obj).use_submodel = true
    const text = detail()
    ;(text.latest_version as Obj).use_submodel = 'true'
    for (const content of [false, true]) {
      expect(field(genitForm(on, { content }), 'use_submodel')).toBe('true')
      expect(field(genitForm(text, { content }), 'use_submodel')).toBe('true')
      expect(field(genitForm(detail(), { content }), 'use_submodel')).toBe('false')
    }
    // 공개 범위만 바꾸는 저장에도 켜 둔 값이 꺼지지 않는다
    const next = genitWorks.applyChanges!(on, { visibility: 'link' })
    expect(field(genitForm(next, { content: false }), 'use_submodel')).toBe('true')
  })

  it('이미 저장 모양인 모델별 프롬프트는 줄바꿈·순서·빈 항목을 그대로 보내고, 옛 형식만 바꾼다', () => {
    const raw = detail()
    const v = raw.latest_version as Obj
    const saved = [
      { tier_key: 'pro', is_active: true, prompt: '프로\r\n둘째' },
      { tier_key: 'basic', is_active: false, prompt: '' },
      { tier_key: 'ultra', is_active: false, prompt: ' 공백 ' }
    ]
    v.tier_prompts = structuredClone(saved)
    expect(parsed(genitForm(raw, { content: true }), 'tier_prompts')).toEqual(saved)
    v.tier_prompts = { pro: '프로', basic: '' }
    expect(parsed(genitForm(raw, { content: true }), 'tier_prompts')).toEqual([
      { tier_key: 'pro', is_active: true, prompt: '프로' }
    ])
  })

  it('시작 상황·캐릭터 목록을 원본에서 못 읽었으면 빈 목록으로 지우지 않고 멈춘다 (null은 없음으로 읽는다)', () => {
    for (const key of ['greetings', 'cast_members']) {
      const raw = detail()
      delete (raw.latest_version as Obj)[key]
      expect(() => genitForm(raw, { content: true })).toThrow('WORK_SHAPE ' + key)
      // 본문을 고치는 계획은 저장 전에 멈춘다. 본문 묶음 없이 가는 저장은 막지 않는다
      expect(() => genitWorks.applyChanges!(raw, { fields: { main: '새 메인' } })).toThrow(
        'WORK_SHAPE ' + key
      )
      expect(() => genitWorks.applyChanges!(raw, { fields: { title: '새 제목' } })).not.toThrow()
      const nulled = detail()
      ;(nulled.latest_version as Obj)[key] = null
      expect(() => genitForm(nulled, { content: true })).not.toThrow()
    }
    const bare = detail()
    delete bare.latest_version
    expect(() => genitWorks.applyChanges!(bare, { fields: { main: '새 메인' } })).toThrow('WORK_SHAPE')
  })

  it('저장 때 걸릴 모양 오류(모델별 프롬프트·성인 여부 없음)는 계획 단계에서 미리 낸다', () => {
    const byModel = { ...detail(), character_prompt: '{"default":"a","pro":"b"}' }
    expect(() =>
      genitWorks.applyChanges!(byModel, { lorebookPatch: [{ index: 0, content: '고침' }] })
    ).toThrow('PROMPT_SHAPE')
    expect(() =>
      genitWorks.applyChanges!({ ...detail(), is_adult: null }, { fields: { title: '새 제목' } })
    ).toThrow('WORK_SHAPE is_adult')
  })

  it('기능 표·못 읽는 칸: 대표 이미지 빼기와 켜짐 여부가 노트에 있다', () => {
    expect(genitWorks.features!.cover.note).toContain('빼기')
    expect(genitWorks.features!.jsx_html.note).not.toContain('그대로 둠')
    const unsupported = genitWorks.normalize(detail()).unsupported!.join('\n')
    expect(unsupported).toContain('활성')
    expect(unsupported).toContain('커버 이미지')
  })
})
