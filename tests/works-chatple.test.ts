import { describe, expect, it } from 'vitest'
import { chatpleBody, chatpleWorks, tidy } from '../src/main/works/chatple'
import type { WorkFetch, WorkWrite } from '../src/main/works/types'

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
