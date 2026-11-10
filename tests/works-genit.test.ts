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
    expect(field(form, 'description')).toBe('소개\n둘째 줄')
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
    // 기존 항목에 분류가 미설정이면 본문 저장 자체를 막는다 (편집기도 막는다)
    const unset = detail()
    ;(unset.lorebooks as Obj[])[0].category = '미설정'
    expect(apply({ fields: { main: '새' } }, unset)).toBe('BAD_LOREBOOK')
    expect(apply({ fields: { title: '새' } }, unset)).toBe('ok')
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
    const plan = await run('work_plan', { site: 'genit', work_id: W, visibility: 'public' })
    await run('work_save', { plan_id: plan.plan_id })
    expect(field(s.sent[0].form!, 'publish_type')).toBe('1')
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
