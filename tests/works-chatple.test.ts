import { describe, expect, it } from 'vitest'
import { chatpleBody, chatpleWorks, tidy } from '../src/main/works/chatple'
import type { LoreEntry, WorkFetch, WorkWrite } from '../src/main/works/types'

// 가짜 응답 모양은 2026-11-10 챗플 공개 스크립트에서 읽은 필드를 따른다
// (/v1/contents/{id}/edit → result {content, pending_edit}, /v1/login/me → result.login, 저장 응답 {statusCode, result}).
const API = 'https://api.chatple.live'
type Obj = Record<string, unknown>
const ok = (result: unknown, status = 200): Response =>
  new Response(JSON.stringify({ statusCode: status, code: '0000', result }), {
    status,
    headers: { 'content-type': 'application/json' }
  })

function content(): Obj {
  return {
    idx: 321,
    mem_no: 77,
    title: '시험 콘텐츠',
    content: '공통 프롬프트',
    avatar_url: 'https://pub-cdn.chatple.live/a.webp',
    creation_type: 'roleplay',
    flag_use: 1,
    flag_adult: 1,
    one_line_intro: '한줄',
    introduction: '소개\n\n\n\n끝 //✎ 메모 ✎//',
    creator_comment: '',
    character_tendency: 'male',
    genre: '판타지',
    content_type: 4,
    rec_view_mode: null,
    rec_tier_idx: 3,
    review_status: 0,
    flag_public: 0,
    hashtags: [{ hashtag: '태그' }],
    characters: [
      {
        character_idx: 11,
        character_name: '하나',
        character_intro: '첫째',
        character_description: '설명1',
        variables: [{ idx: 5, name: '호감', default_value: 10, min_value: 0, max_value: 100 }]
      },
      {
        character_idx: 12,
        character_name: '둘',
        character_intro: '',
        character_description: '설명2'
      }
    ],
    starts: [
      {
        idx: 901,
        title: '기본',
        content: '상황 설명',
        prompt_content: '',
        first_message: '첫 메시지',
        flag_default: 1,
        sort_no: 0,
        recommend_suggestion: ['응', '', ''],
        flag_public: 1
      },
      {
        idx: 902,
        title: '둘째',
        content: '',
        prompt_content: '둘째 전용',
        first_message: '[{"idx":1,"type":"narration","text":"둘째"}]',
        flag_default: 0,
        sort_no: 1,
        flag_public: 0
      }
    ],
    memorybooks: [
      { idx: 51, title: '장소', keywords: ['성'], content: '성 설명', target_start_idxs: [902] },
      { idx: 52, title: '옛 모양', keyword: '가|나', content: '옛 내용' }
    ]
  }
}
function reader(c: Obj, pending: unknown = null, seen: string[] = []): WorkFetch {
  return async (url) => {
    seen.push(url)
    if (url === API + '/v1/contents/321/edit') return ok({ content: c, pending_edit: pending })
    if (url === API + '/v1/login/me') return ok({ login: { mem_no: 77 } })
    if (url === API + '/v1/contents/creator/77')
      return ok({
        contents: [
          { idx: 321, title: '시험 콘텐츠', flag_use: 1, reg_dt: '2026-11-01 10:00:00' },
          { idx: 322, title: '공개작', flag_use: 0, flag_public: 1 },
          { idx: 321, title: '중복' }
        ]
      })
    return ok(null, 404)
  }
}

describe('챗플 작품 연결부 — 주소·읽기', () => {
  it('편집 화면이 쓰는 주소만 읽고 쓴다', () => {
    const r = chatpleWorks.readAllowed
    expect(r(API + '/v1/contents/321/edit')).toBe(true)
    expect(r(API + '/v1/login/me')).toBe(true)
    expect(r(API + '/v1/contents/creator/77')).toBe(true)
    expect(r(API + '/v1/contents/321')).toBe(false)
    expect(r(API + '/v1/contents/321/edit?x=1')).toBe(false)
    expect(r('https://api-chatple.novelpia.com/v1/contents/321/edit')).toBe(false)
    const w = chatpleWorks.writeAllowed!
    expect(w('PUT', API + '/v1/contents/321')).toBe(true)
    expect(w('PUT', API + '/v1/characters/11')).toBe(true)
    expect(w('DELETE', API + '/v1/contents/321')).toBe(true)
    expect(w('POST', API + '/v1/contents')).toBe(false)
    expect(w('DELETE', API + '/v1/characters/11')).toBe(false)
    expect(w('PUT', API + '/v1/characters/albums/batch-sync')).toBe(false)
  })

  it('내 목록은 계정 번호로 읽고 번호 중복을 걸러 낸다', async () => {
    const items = await chatpleWorks.list(reader(content()))
    expect(items.map((i) => [i.id, i.visibility, i.status])).toEqual([
      ['321', 'private', 'private'],
      ['322', 'public', 'approved']
    ])
  })

  it('콘텐츠를 공통 모양으로 옮긴다', async () => {
    const body = chatpleWorks.normalize(await chatpleWorks.readRaw(reader(content()), '321'))
    expect(body.fields).toEqual({
      title: '시험 콘텐츠',
      subtitle: '한줄',
      description: '소개\n\n\n\n끝 //✎ 메모 ✎//',
      main: '공통 프롬프트',
      creator_comment: ''
    })
    expect(body.visibility).toBe('private')
    expect(body.lorebook.map((l) => [l.title, l.keys])).toEqual([
      ['장소', '성'],
      ['옛 모양', '가, 나']
    ])
    expect(
      body.startScenarios.map((s) => [s.id, s.title, s.content, s.situation, s.isDefault])
    ).toEqual([
      ['901', '기본', '첫 메시지', '상황 설명', true],
      ['902', '둘째', '[{"idx":1,"type":"narration","text":"둘째"}]', '', false]
    ])
    expect(body.characters.map((c) => [c.id, c.name, c.info, c.details, c.isMain])).toEqual([
      ['11', '하나', '첫째', '설명1', true],
      ['12', '둘', '', '설명2', false]
    ])
  })
})

describe('챗플 작품 연결부 — 바꾸기·저장', () => {
  it('저장 본문은 편집 화면 수정 완료와 같은 모양이다', () => {
    const body = chatpleBody(content())
    expect(body).toMatchObject({
      title: '시험 콘텐츠',
      content: '공통 프롬프트',
      flag_use: 1,
      flag_adult: 1,
      introduction: '소개\n\n끝',
      character_tendency: 'male',
      content_type: 4,
      rec_view_mode: '',
      rec_tier_idx: 3,
      character_idxs: [11, 12],
      hashtags: ['태그']
    })
    expect(body.avatar_url).toBeUndefined()
    expect(body.creator_comment).toBeUndefined()
    const starts = body.starts as Obj[]
    expect(starts[0]).toMatchObject({
      idx: 901,
      flag_default: 1,
      recommend_suggestion: ['응'],
      flag_public: 1
    })
    expect(starts[1]).toMatchObject({ idx: 902, flag_public: 0, prompt_content: '둘째 전용' })
    const books = body.memorybooks as Obj[]
    // 메모리북의 도입부 번호는 도입부 자리(0부터)로 보낸다
    expect(books[0]).toMatchObject({
      idx: 51,
      keywords: ['성'],
      target_start_idxs: [1],
      sort_no: 0
    })
    expect(books[1]).toMatchObject({ idx: 52, keywords: ['가', '나'], sort_no: 1 })
    expect(tidy('가\n\n\n나 //✎ x ✎// 다')).toBe('가\n\n나다')
  })

  it('글 칸·메모리북·도입부·캐릭터를 고치고, 바뀐 캐릭터만 먼저 저장한다', async () => {
    const raw = await chatpleWorks.readRaw(reader(content()), '321')
    const next = chatpleWorks.applyChanges!(raw, {
      visibility: 'link',
      fields: { main: '새 공통' },
      lorebookRemove: [1],
      lorebookAdd: [
        {
          title: '새',
          keys: '키',
          content: '새 내용',
          mode: null,
          offKeys: [],
          turnRange: null,
          offTurnRange: null
        }
      ],
      startScenarios: [{ index: 1, content: '둘째 새 메시지', situation: '둘째 상황' }],
      characters: [{ index: 1, details: '새 설명2' }]
    })
    const body = chatpleWorks.normalize(next)
    expect(body.visibility).toBe('link')
    expect(body.fields.description).toBe('소개\n\n끝')
    expect(body.lorebook.map((l) => l.title)).toEqual(['장소', '새'])
    expect(body.startScenarios[1]).toMatchObject({
      content: '둘째 새 메시지',
      situation: '둘째 상황'
    })
    const sent: { method: string; url: string; body: Obj }[] = []
    const write: WorkWrite = async (method, url, b) => {
      sent.push({ method, url, body: b as Obj })
      return ok({ start_idxs: [901, 902] })
    }
    await chatpleWorks.save!(write, '321', next)
    expect(sent.map((s) => s.method + ' ' + s.url)).toEqual([
      'PUT ' + API + '/v1/characters/12',
      'PUT ' + API + '/v1/contents/321'
    ])
    expect(sent[0].body).toEqual({
      name: '둘',
      one_line_intro: '',
      description: '새 설명2',
      variables: undefined
    })
    expect(sent[1].body.flag_use).toBe(2)
    expect((sent[1].body.memorybooks as Obj[]).map((m) => m.idx)).toEqual([51, undefined])
  })

  it('도입부·캐릭터 추가와 빼기, 없는 칸, 심사 중 저장은 막는다', async () => {
    const raw = await chatpleWorks.readRaw(reader(content()), '321')
    const apply = chatpleWorks.applyChanges!
    expect(() => apply(raw, { startScenariosAdd: [{ title: 'x', content: 'y' }] })).toThrow(
      'START_STRUCTURE_UNSUPPORTED'
    )
    expect(() => apply(raw, { startScenariosRemove: [1] })).toThrow('START_STRUCTURE_UNSUPPORTED')
    expect(() => apply(raw, { charactersAdd: [{ name: '셋' }] })).toThrow(
      'CHARACTER_STRUCTURE_UNSUPPORTED'
    )
    expect(() => apply(raw, { fields: { play_guide: 'x' } })).toThrow('BAD_FIELD')
    expect(() => apply(raw, { fields: { title: '' } })).toThrow('BAD_FIELD')
    expect(() => apply(raw, { lorebookPatch: [{ index: 0, mode: 'always' }] })).toThrow(
      'BAD_CHANGES'
    )
    expect(() => apply(raw, { lorebookPatch: [{ index: 0, keys: '' }] })).toThrow('BAD_LOREBOOK')
    expect(() => apply(raw, { characters: [{ index: 1, name: '하나' }] })).toThrow('BAD_CHARACTER')
    const pending = await chatpleWorks.readRaw(reader(content(), { status: 1 }), '321')
    expect(() => apply(pending, { fields: { main: 'x' } })).toThrow('IN_REVIEW')
  })

  it('거절·로그인 만료·본문 실패를 구분한다', async () => {
    const raw = await chatpleWorks.readRaw(reader(content()), '321')
    const next = chatpleWorks.applyChanges!(raw, { fields: { main: 'x' } })
    const authError = async (): Promise<Response> =>
      new Response(
        JSON.stringify({ statusCode: 401, result: { name: 'AUTH_ERROR', code: '0001' } }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' }
        }
      )
    await expect(chatpleWorks.save!(authError, '321', next)).rejects.toThrow('LOGIN_REQUIRED')
    await expect(
      chatpleWorks.save!(async () => ok({ name: 'CONTENT_ERROR', code: '0007' }, 400), '321', next)
    ).rejects.toThrow('SAVE_FAILED 400 CONTENT_ERROR:0007')
    await expect(
      chatpleWorks.save!(
        async () =>
          new Response(JSON.stringify({ statusCode: 500, code: '9999', result: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }),
        '321',
        next
      )
    ).rejects.toThrow('SAVE_FAILED 500')
  })

  it('작품 삭제는 DELETE /v1/contents/{id}', async () => {
    const sent: string[] = []
    await chatpleWorks.remove!(async (method, url) => {
      sent.push(method + ' ' + url)
      return ok({})
    }, '321')
    expect(sent).toEqual(['DELETE ' + API + '/v1/contents/321'])
    expect(chatpleWorks.create).toBeUndefined()
    expect(chatpleWorks.applyImages).toBeUndefined()
  })
})

// ── 손대지 않은 값은 원본 그대로 (2026-11-13 왕복 분석 반영) ──
const lore = (title: string, keys: string, body: string): LoreEntry => ({
  title,
  keys,
  content: body,
  mode: null,
  offKeys: [],
  turnRange: null,
  offTurnRange: null
})
const rawOf = (c: Obj): Promise<unknown> => chatpleWorks.readRaw(reader(c), '321')
const sentBody = (next: unknown): Obj => chatpleBody((next as { content: Obj }).content)

describe('챗플 작품 연결부 — 전체 교체 짝짓기', () => {
  it('제목으로 옛 항목과 짝짓고, 짝 없는 새 항목은 옛 번호·도입부 연결을 물려받지 않는다', async () => {
    const next = chatpleWorks.applyChanges!(await rawOf(content()), {
      lorebook: [lore('옛 모양', '다', '바뀐 내용'), lore('새 것', '라', '새 내용'), lore('장소', '성', '성 설명')]
    })
    const books = sentBody(next).memorybooks as Obj[]
    expect(books.map((m) => [m.title, m.idx, m.target_start_idxs])).toEqual([
      ['옛 모양', 52, undefined],
      ['새 것', undefined, undefined],
      ['장소', 51, [1]]
    ])
  })

  it('같은 자리에서 제목만 고친 항목은 옛 항목을 잇는다', async () => {
    const next = chatpleWorks.applyChanges!(await rawOf(content()), {
      lorebook: [lore('장소 고침', '성', '성 설명'), lore('옛 모양', '가, 나', '옛 내용')]
    })
    const books = sentBody(next).memorybooks as Obj[]
    expect(books.map((m) => [m.title, m.idx, m.target_start_idxs])).toEqual([
      ['장소 고침', 51, [1]],
      ['옛 모양', 52, undefined]
    ])
  })

  it('쉼표가 든 키워드는 work_read가 준 keys를 그대로 돌려줘도 갈라지지 않는다', async () => {
    const c = content()
    ;(c.memorybooks as Obj[])[0].keywords = ['a,b', 'c']
    const raw = await rawOf(c)
    const keys = chatpleWorks.normalize(raw).lorebook[0].keys
    expect(keys).toBe('a,b, c')
    const same = chatpleWorks.applyChanges!(raw, {
      lorebook: [lore('장소', keys, '성 설명'), lore('옛 모양', '가, 나', '옛 내용')]
    })
    expect((sentBody(same).memorybooks as Obj[])[0].keywords).toEqual(['a,b', 'c'])
    // keys를 실제로 바꾸면 쉼표로 나눈다
    const changed = chatpleWorks.applyChanges!(raw, { lorebookPatch: [{ index: 0, keys: 'x, y' }] })
    expect((sentBody(changed).memorybooks as Obj[])[0].keywords).toEqual(['x', 'y'])
  })
})

describe('챗플 작품 연결부 — 말없이 채우지 않는다', () => {
  it('공개 범위를 모르면 공개(0)로 보내지 않고 멈춘다', async () => {
    for (const bad of [undefined, null, 'x', 7]) {
      const c = content()
      c.flag_use = bad
      expect(() => chatpleBody(c)).toThrow('UNKNOWN_VISIBILITY')
      const raw = await rawOf(c)
      expect(chatpleWorks.normalize(raw).visibility).toBeNull()
      expect(chatpleWorks.normalize(raw).status).toBeNull()
      expect(() => chatpleWorks.applyChanges!(raw, { fields: { main: 'x' } })).toThrow(
        'UNKNOWN_VISIBILITY'
      )
    }
    // 사용자가 공개 범위를 직접 정하면 그 값으로 보낸다
    const c = content()
    delete c.flag_use
    const next = chatpleWorks.applyChanges!(await rawOf(c), { visibility: 'private' })
    expect(sentBody(next).flag_use).toBe(1)
  })

  it('원본에 칸이 없거나 null일 때만 예전 기본값(roleplay·all·0)을 보내고, 값이 있으면 그대로 보낸다', () => {
    const c = content()
    delete c.creation_type
    delete c.character_tendency
    delete c.content_type
    expect(chatpleBody(c)).toMatchObject({
      creation_type: 'roleplay',
      character_tendency: 'all',
      content_type: 0
    })
    c.creation_type = null
    c.character_tendency = null
    c.content_type = null
    expect(chatpleBody(c)).toMatchObject({
      creation_type: 'roleplay',
      character_tendency: 'all',
      content_type: 0
    })
    // 있으면 그대로 (예전 기본값으로 덮지 않는다)
    c.creation_type = 'story'
    c.character_tendency = 'female'
    c.content_type = 5
    expect(chatpleBody(c)).toMatchObject({
      creation_type: 'story',
      character_tendency: 'female',
      content_type: 5
    })
    // 0·4·5가 아닌 형식은 편집 화면처럼 칸을 뺀다
    c.content_type = 3
    expect(chatpleBody(c).content_type).toBeUndefined()
  })

  it('성인 표시는 "0" 글도 비성인으로 보내고, 칸이 없거나 null이면 예전처럼 성인(1)으로 보낸다', () => {
    const c = content()
    for (const [value, sent] of [
      [0, 0],
      [false, 0],
      ['0', 0],
      [1, 1],
      [true, 1],
      ['1', 1],
      [null, 1],
      [undefined, 1]
    ] as const) {
      c.flag_adult = value
      expect(chatpleBody(c).flag_adult, String(value)).toBe(sent)
    }
  })

  it('도입부 공개 여부는 원본 값 그대로 보내고, 모르면 공개(1)로 보내지 않고 멈춘다', () => {
    const c = content()
    ;(c.starts as Obj[])[0].flag_public = 0
    expect((chatpleBody(c).starts as Obj[])[0]).toMatchObject({ flag_default: 1, flag_public: 0 })
    for (const bad of [undefined, null, 'x']) {
      ;(c.starts as Obj[])[1].flag_public = bad
      expect(() => chatpleBody(c)).toThrow('UNKNOWN_START_PUBLIC starts[1]')
    }
  })

  it('도입부 공개 여부를 모르는 작품은 캐릭터를 하나도 저장하기 전에 계획 단계에서 멈춘다', async () => {
    for (const bad of [undefined, null, true, 2]) {
      const c = content()
      ;(c.starts as Obj[])[1].flag_public = bad
      const raw = await rawOf(c)
      // 캐릭터만 고치는 계획도, 아무것도 안 고치는 계획도 applyChanges에서 멈춘다 (save()의 캐릭터 PUT까지 가지 않는다)
      expect(() =>
        chatpleWorks.applyChanges!(raw, { characters: [{ index: 0, details: '새 설명' }] })
      ).toThrow('UNKNOWN_START_PUBLIC starts[1]')
      expect(() => chatpleWorks.applyChanges!(raw, { fields: { main: 'x' } })).toThrow(
        'UNKNOWN_START_PUBLIC'
      )
    }
  })

  it('캐릭터 변수는 개수를 자르지 않고 읽은 값 그대로 되돌려 보낸다 (칸이 없거나 null일 때만 예전 기본값)', async () => {
    const c = content()
    ;(c.characters as Obj[])[0].variables = [1, 2, 3, 4].map((n) => ({
      idx: n,
      name: ' 변수' + n + ' ',
      description: n === 3 ? '' : ' 설명 ',
      default_value: n === 2 ? null : n === 4 ? '7' : n,
      min_value: n === 1 ? undefined : 0,
      max_value: 9,
      sort_no: 10 + n
    }))
    const next = chatpleWorks.applyChanges!(await rawOf(c), { characters: [{ index: 0, details: '새 설명' }] })
    const sent: Obj[] = []
    await chatpleWorks.save!(
      async (_m, _u, b) => {
        sent.push(b as Obj)
        return ok({})
      },
      '321',
      next
    )
    const vars = sent[0].variables as Obj[]
    expect(vars.map((v) => v.idx)).toEqual([1, 2, 3, 4])
    // 다듬지 않는다: 공백, 빈 소개, 글로 된 기본값, 원본 순서 번호
    expect(vars.map((v) => v.name)).toEqual([' 변수1 ', ' 변수2 ', ' 변수3 ', ' 변수4 '])
    expect(vars.map((v) => v.description)).toEqual([' 설명 ', ' 설명 ', '', ' 설명 '])
    expect(vars.map((v) => v.sort_no)).toEqual([11, 12, 13, 14])
    // 칸이 없거나 null일 때만 예전 기본값
    expect(vars.map((v) => v.default_value)).toEqual([1, 0, 3, '7'])
    expect(vars[0].min_value).toBeNull()
    expect(vars[1].min_value).toBe(0)
  })

  it('추천 답변은 4개 이상이어도 자르지 않는다', () => {
    const c = content()
    ;(c.starts as Obj[])[0].recommend_suggestion = ['가', '나', '다', '라']
    expect(((chatpleBody(c).starts as Obj[])[0] as Obj).recommend_suggestion).toEqual([
      '가',
      '나',
      '다',
      '라'
    ])
  })

  it('수정 시각은 update_dt를 읽는다 (없을 때만 upd_dt, 등록 시각)', async () => {
    const c = content()
    c.reg_dt = '2026-09-20 02:56:02'
    expect(chatpleWorks.normalize(await rawOf(c)).updatedAt).toBe('2026-09-20 02:56:02')
    c.update_dt = '2026-11-10 06:42:00'
    expect(chatpleWorks.normalize(await rawOf(c)).updatedAt).toBe('2026-11-10 06:42:00')
    const listed = await chatpleWorks.list(async (url) =>
      url.endsWith('/v1/login/me')
        ? ok({ login: { mem_no: 77 } })
        : ok({ contents: [{ idx: 5, title: 't', flag_use: 0, reg_dt: 'a', update_dt: 'b' }] })
    )
    expect(listed[0].updatedAt).toBe('b')
  })
})

describe('챗플 작품 연결부 — 기능 표·숨은 설정·못 읽는 칸', () => {
  const KEYS = [
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
  /** 지어낸 원본: 숨은 설정이 모두 있는 작품 */
  function rich(): Obj {
    const c = content()
    Object.assign(c, {
      genre: 'fantasy',
      character_tendency: 'all',
      original_language: 'ko',
      flag_adult: 0,
      content_type: 5,
      content_flag: 0,
      rec_view_mode: null,
      rec_tier_idx: 2,
      prompt_profile_idx: 4,
      tier_group_idx: null,
      scoring_profile_idx: null,
      avatar_url: '//cdn.example/a.webp?token=SECRET',
      poster_url: '',
      share_token: 'SECRET-TOKEN',
      original_novel_idx: null,
      review_status: 2,
      review_reason: null,
      review_dt: '2026-09-21 11:07:37',
      open_dt: '2026-09-21 11:07:37',
      unpublish_dt: null,
      flag_official: 0,
      is_exclusive: 1,
      is_plus: 0,
      is_original: 0,
      is_novel: 0,
      is_contest: false,
      flag_lite: 0,
      flag_pick_mode: 1,
      flag_album_open: 0,
      flag_char_source: 0,
      flag_marketing: 0,
      view_count: 10,
      chat_count: 3,
      like_count: 2,
      creator_username: 'someone',
      mem_no: 77,
      hashtags: ['가', '나', { hashtag: '다' }]
    })
    ;(c.starts as Obj[])[0].start_image_url = '//cdn.example/s.png'
    ;(c.starts as Obj[])[1].secret = '비밀'
    ;(c.characters as Obj[])[0].character_avatar_url = '//cdn.example/c.png'
    return c
  }

  it('기능 표에 열쇠 22개가 모두 있고 note는 40자 이내다', () => {
    const f = chatpleWorks.features!
    expect(Object.keys(f).sort()).toEqual([...KEYS].sort())
    for (const [k, v] of Object.entries(f)) {
      expect(['yes', 'no', 'unknown']).toContain(v.site)
      expect((v.note ?? '').length, k).toBeLessThanOrEqual(40)
    }
    expect(f.create_work).toMatchObject({ site: 'yes', write: 'no' })
    expect(f.lorebook.write).toBe('partial')
    expect(f.comments_stats.read).toBe('no')
  })

  it('숨은 설정은 있는 칸만 짧은 값·개수로 싣고 토큰·주소·통계·계정은 싣지 않는다', async () => {
    const body = chatpleWorks.normalize(await rawOf(rich()))
    expect(body.extras).toEqual({
      genre: 'fantasy',
      character_tendency: 'all',
      creation_type: 'roleplay',
      original_language: 'ko',
      hashtags: ['가', '나', '다'],
      is_adult: false,
      content_type: 5,
      content_flag: 0,
      rec_view_mode: null,
      rec_tier_idx: 2,
      prompt_profile_idx: 4,
      tier_group_idx: null,
      scoring_profile_idx: null,
      has_cover_image: true,
      has_poster_image: false,
      has_share_token: true,
      has_original_novel: false,
      review_status: 2,
      has_review_reason: false,
      review_dt: '2026-09-21 11:07:37',
      open_dt: '2026-09-21 11:07:37',
      unpublish_dt: null,
      pending_edit_status: null,
      is_official: false,
      is_exclusive: true,
      is_plus: false,
      is_original: false,
      is_novel: false,
      is_contest: false,
      lite_mode: false,
      pick_mode: true,
      album_open: false,
      char_source: false,
      marketing: false,
      start_image_count: 1,
      recommended_reply_count: 1,
      unpublished_start_count: 1,
      start_secret_count: 1,
      start_writing_style_count: 0,
      character_variable_count: 1,
      character_image_count: 1,
      memorybook_linked_count: 1
    })
    const dump = JSON.stringify(body.extras)
    for (const leak of ['SECRET', 'cdn.example', 'someone', 'view_count', '77']) expect(dump).not.toContain(leak)
  })

  it('반려 사유는 글을 싣지 않고 있음/없음만 싣는다', async () => {
    const c = rich()
    c.review_reason = '작품 문장 "비밀 대사"를 인용한 반려 사유'
    const extras = chatpleWorks.normalize(await rawOf(c)).extras!
    expect(extras.has_review_reason).toBe(true)
    expect(extras).not.toHaveProperty('review_reason')
    expect(JSON.stringify(extras)).not.toContain('비밀 대사')
    c.review_reason = '  '
    expect(chatpleWorks.normalize(await rawOf(c)).extras!.has_review_reason).toBe(false)
    delete c.review_reason
    expect(chatpleWorks.normalize(await rawOf(c)).extras).not.toHaveProperty('has_review_reason')
  })

  it('기능 표의 판본 칸은 확인한 것이 없으므로 verified가 no다', () => {
    expect(chatpleWorks.features!.language_editions).toMatchObject({
      site: 'unknown',
      read: 'no',
      write: 'no',
      verified: 'no'
    })
  })

  it('칸이 없는 작품은 없는 칸을 지어내지 않고, 긴 글·긴 태그 목록은 길이·개수로 줄인다', async () => {
    const c = content()
    c.genre = '장'.repeat(100)
    c.hashtags = Array.from({ length: 21 }, (_, i) => '태그' + i)
    const extras = chatpleWorks.normalize(await rawOf(c)).extras!
    expect(extras.review_status).toBe(0)
    expect(extras).not.toHaveProperty('review_dt')
    expect(extras).not.toHaveProperty('is_exclusive')
    expect(extras).not.toHaveProperty('has_share_token')
    expect(extras.genre).toBeUndefined()
    expect(extras.genre_length).toBe(100)
    expect(extras.hashtags).toBeUndefined()
    expect(extras.hashtag_count).toBe(21)
    const pending = chatpleWorks.normalize(await chatpleWorks.readRaw(reader(content(), { status: 3 }), '321'))
    expect(pending.extras!.pending_edit_status).toBe(3)
  })

  it('못 읽는 칸을 알리고, 공통 칸과 계획 비교에 쓰는 값은 그대로이며 읽을 때마다 같다', async () => {
    const plain = chatpleWorks.normalize(await rawOf(content()))
    expect(plain.unsupported).toEqual(
      expect.arrayContaining(['캐릭터 이미지(앨범)', '캐릭터 변수 내용', '메모리북의 도입부 연결', '임시저장본'])
    )
    const withStats = rich()
    const a = chatpleWorks.normalize(await rawOf(withStats))
    withStats.view_count = 9999
    withStats.chat_count = 5000
    withStats.like_count = 777
    const b = chatpleWorks.normalize(await rawOf(withStats))
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    const { extras: _e, unsupported: _u, ...rest } = plain
    expect(rest.visibility).toBe('private')
    expect(rest.lorebook.map((l) => l.keys)).toEqual(['성', '가, 나'])
  })

  it('전체 교체 항목의 given은 저장 본문에 영향이 없고, 챗플에 없는 칸에 값을 주면 그대로 거절한다', async () => {
    const raw = await rawOf(content())
    const withGiven = (extra: Partial<LoreEntry>, given: string[]): LoreEntry => ({
      ...lore('장소', '성', '성 설명'),
      ...extra,
      given
    })
    const kept = chatpleWorks.applyChanges!(raw, {
      lorebook: [withGiven({}, ['title', 'keys', 'content']), lore('옛 모양', '가, 나', '옛 내용')]
    })
    const books = sentBody(kept).memorybooks as Obj[]
    expect(books[0]).toMatchObject({ idx: 51, title: '장소', keywords: ['성'], target_start_idxs: [1] })
    expect(books[0]).not.toHaveProperty('mode')
    expect(() =>
      chatpleWorks.applyChanges!(raw, {
        lorebook: [withGiven({ mode: 'always' }, ['title', 'keys', 'content', 'mode'])]
      })
    ).toThrow('BAD_CHANGES')
  })

  it('전체 교체에서 given에 없는 칸(keys·title·content)은 옛 값을 그대로 두고 막지 않는다', async () => {
    const raw = await rawOf(content())
    const old = lore('옛 모양', '가, 나', '옛 내용')
    const sentBooks = (lorebook: LoreEntry[]): Obj[] =>
      sentBody(chatpleWorks.applyChanges!(raw, { lorebook })).memorybooks as Obj[]
    // keys를 안 줌 → 옛 키워드 그대로 (BAD_LOREBOOK .keys로 막히지 않는다)
    let books = sentBooks([{ ...lore('장소', '', '바뀐 성 설명'), given: ['title', 'content'] }, old])
    expect(books[0]).toMatchObject({ idx: 51, title: '장소', keywords: ['성'], content: '바뀐 성 설명' })
    // title을 안 줌 → 옛 제목 그대로 (빈 제목으로 지우지 않는다)
    books = sentBooks([{ ...lore('', '새 키', '성 설명'), given: ['keys', 'content'] }, old])
    expect(books[0]).toMatchObject({ idx: 51, title: '장소', keywords: ['새 키'], content: '성 설명' })
    // content를 안 줌 → 옛 내용 그대로
    books = sentBooks([{ ...lore('장소', '성', ''), given: ['title', 'keys'] }, old])
    expect(books[0]).toMatchObject({ idx: 51, title: '장소', keywords: ['성'], content: '성 설명' })
    // 실제로 빈 값을 줬으면 비운 것이다 (지금처럼 거절)
    expect(() => sentBooks([lore('장소', '', '성 설명'), old])).toThrow('BAD_LOREBOOK lorebook[0].keys')
    expect(() => sentBooks([lore('장소', '성', ''), old])).toThrow('BAD_LOREBOOK lorebook[0].content')
  })
})

describe('챗플 작품 연결부 — 바뀐 항목만 검사', () => {
  /** 사이트가 받아 준 옛 값이지만 지금 한도·필수 규칙으로는 걸리는 것들이 든 작품 */
  function legacy(): Obj {
    const c = content()
    c.creator_comment = '코'.repeat(1200)
    ;(c.starts as Obj[])[0].content = '상'.repeat(2100)
    ;(c.starts as Obj[]).push({
      idx: 903,
      title: '셋째',
      content: '',
      prompt_content: '',
      first_message: '',
      flag_default: 0,
      sort_no: 2,
      flag_public: 0
    })
    ;(c.memorybooks as Obj[]).push(
      { idx: 53, title: '', keywords: [], content: '' },
      { idx: 54, title: '긴 것', keywords: ['1', '2', '3', '4', '5', '6', '7'], content: '내'.repeat(460) }
    )
    ;(c.characters as Obj[]).push(
      { character_idx: 13, character_name: '하나', character_intro: '소'.repeat(250), character_description: '설명3' }
    )
    return c
  }

  it('안 건드린 옛 항목이 한도를 넘거나 비어 있어도 저장이 막히지 않고 원본 그대로 나간다', async () => {
    const next = chatpleWorks.applyChanges!(await rawOf(legacy()), { fields: { main: '새 공통' } })
    const body = sentBody(next)
    expect(body.creator_comment).toBe('코'.repeat(1200))
    const starts = body.starts as Obj[]
    expect(starts.map((s) => s.idx)).toEqual([901, 902, 903])
    expect(starts[0].content).toBe('상'.repeat(2100))
    expect(starts[2]).toMatchObject({ title: '셋째', first_message: '', flag_public: 0 })
    const books = body.memorybooks as Obj[]
    expect(books.map((m) => m.idx)).toEqual([51, 52, 53, 54])
    expect(books[2]).toMatchObject({ keywords: [], content: '' })
    expect(books[3].keywords).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(books[3].content).toBe('내'.repeat(460))
  })

  it('옛 항목의 다른 칸만 고치면 그 항목의 안 바뀐 칸은 검사하지 않는다', async () => {
    const next = chatpleWorks.applyChanges!(await rawOf(legacy()), {
      lorebookPatch: [{ index: 3, title: '제목만 고침' }],
      startScenarios: [{ index: 0, title: '기본 고침' }],
      characters: [{ index: 2, details: '새 설명3' }]
    })
    const body = sentBody(next)
    expect((body.memorybooks as Obj[])[3]).toMatchObject({
      title: '제목만 고침',
      content: '내'.repeat(460)
    })
    expect((body.starts as Obj[])[0]).toMatchObject({ title: '기본 고침', content: '상'.repeat(2100) })
  })

  it('바꾸거나 새로 더한 칸은 한도를 지킨다 (메모리북 450자·키워드 5개는 잘리지 않고 거절된다)', async () => {
    const raw = await rawOf(content())
    const apply = chatpleWorks.applyChanges!
    expect(() => apply(raw, { lorebookPatch: [{ index: 0, content: '긴'.repeat(451) }] })).toThrow(
      'BAD_LOREBOOK lorebook[0].content'
    )
    expect(() => apply(raw, { lorebookAdd: [lore('', '키', '긴'.repeat(451))] })).toThrow(
      'BAD_LOREBOOK lorebook[2].content'
    )
    expect(() => apply(raw, { lorebookAdd: [lore('', '1,2,3,4,5,6', '내용')] })).toThrow(
      'BAD_LOREBOOK lorebook[2].keys'
    )
    expect(() => apply(raw, { lorebookAdd: [lore('제'.repeat(31), '키', '내용')] })).toThrow(
      'BAD_LOREBOOK lorebook[2].title'
    )
    expect(() =>
      apply(raw, { lorebook: [lore('장소', '성', '긴'.repeat(451)), lore('옛 모양', '가', '옛')] })
    ).toThrow('BAD_LOREBOOK lorebook[0].content')
    expect(() => apply(raw, { startScenarios: [{ index: 0, situation: '상'.repeat(2001) }] })).toThrow(
      'BAD_START start_scenarios[0].situation'
    )
    expect(() => apply(raw, { startScenarios: [{ index: 0, title: '' }] })).toThrow(
      'BAD_START start_scenarios[0].title'
    )
    expect(() => apply(raw, { startScenarios: [{ index: 0, content: ' ' }] })).toThrow(
      'BAD_START start_scenarios[0].content'
    )
    expect(() => apply(raw, { characters: [{ index: 0, info: '소'.repeat(201) }] })).toThrow(
      'BAD_CHARACTER characters[0].info'
    )
    expect(() => apply(raw, { characters: [{ index: 0, details: ' ' }] })).toThrow(
      'BAD_CHARACTER characters[0].details'
    )
    expect(() => apply(raw, { fields: { creator_comment: '코'.repeat(1001) } })).toThrow('BAD_FIELD')
    // 경계 값은 통과한다
    const edge = apply(raw, { lorebookAdd: [lore('', '1,2,3,4,5', '긴'.repeat(450))] })
    const added = (sentBody(edge).memorybooks as Obj[])[2]
    expect(added.content).toBe('긴'.repeat(450))
    expect(added.keywords).toHaveLength(5)
  })

  it('이미 바뀐 항목을 한 계획 안에서 다시 고쳐도 처음 원본이 기준이다', async () => {
    const raw = await rawOf(content())
    expect(() =>
      chatpleWorks.applyChanges!(raw, {
        lorebook: [lore('장소', '성', '긴'.repeat(451)), lore('옛 모양', '가', '옛')],
        lorebookPatch: [{ index: 0, title: '장소2' }]
      })
    ).toThrow('BAD_LOREBOOK lorebook[0].content')
  })

  it('같은 항목을 lorebook_patch로 두 번 고쳐도 처음 원본이 기준이다 (도구에서 닿는 경로)', async () => {
    const raw = await rawOf(legacy())
    const apply = chatpleWorks.applyChanges!
    // 안 건드린 450자 초과·키워드 7개 옛 항목은 제목만 두 번 고쳐도 막히지 않고 원본 그대로 나간다
    const twice = apply(raw, {
      lorebookPatch: [
        { index: 3, title: '고침 1' },
        { index: 3, title: '고침 2' }
      ]
    })
    expect((sentBody(twice).memorybooks as Obj[])[3]).toMatchObject({
      idx: 54,
      title: '고침 2',
      content: '내'.repeat(460),
      keywords: ['1', '2', '3', '4', '5', '6', '7']
    })
    // 두 번째 고침이 내용을 바꾸면 그때부터 검사한다
    expect(() =>
      apply(raw, {
        lorebookPatch: [
          { index: 3, title: '고침 1' },
          { index: 3, content: '내'.repeat(451) }
        ]
      })
    ).toThrow('BAD_LOREBOOK lorebook[3].content')
    // 첫 고침이 내용을 한도 안으로 줄였고 두 번째가 같은 내용으로 다시 고쳐도 통과한다
    const fixed = apply(raw, {
      lorebookPatch: [
        { index: 3, content: '내'.repeat(100), keys: '1,2,3' },
        { index: 3, title: '고침' }
      ]
    })
    expect((sentBody(fixed).memorybooks as Obj[])[3]).toMatchObject({
      content: '내'.repeat(100),
      keywords: ['1', '2', '3'],
      title: '고침'
    })
  })
})
