import { describe, expect, it } from 'vitest'
import { edenCreateBody, edenSaveBody, edenWorks } from '../src/main/works/eden'
import { workAdapter, workReadAllowed } from '../src/main/works/adapters'
import { createWorkTools, toolMessage } from '../src/main/works/tools'
import type { WorkFetch } from '../src/main/works/types'

const W = '11111111-2222-4333-8444-555555555555'
const C1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1'
const C2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2'
const O = 'https://www.eden-chat.com'

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

const WORK = {
  id: W,
  title: '시험 작품',
  subtitle: '부제',
  description: '소개 🌸',
  scenario_settings: '메인 프롬프트',
  creator_comment: null,
  visibility: 'private',
  status: 'draft',
  updated_at: '2026-11-10T06:50:23.855Z',
  lorebook: [
    {
      key: '학교, 교실',
      title: '☀️ 일상',
      value: '로어 본문',
      triggerMode: 'keyword',
      offKeywords: ['밤'],
      turnRange: 5,
      offTurnRange: 5
    }
  ],
  start_scenarios: [
    { id: 1, title: '기본', isDefault: true, detailedSettings: '시작 본문', subPrompt: '보조' }
  ]
}

function fake(extra: Record<string, unknown> = {}): { read: WorkFetch; calls: string[] } {
  const routes: Record<string, unknown> = {
    [O + '/api/user/works']: {
      success: true,
      works: [
        { id: W, title: '시험 작품', visibility: 'private', status: 'draft', character_count: 2 },
        { id: 'x', title: '다른 것', visibility: 'public', status: 'active' }
      ]
    },
    [O + '/api/works/' + W]: WORK,
    [O + '/api/works/' + W + '/characters']: [
      { id: C2, character_name: '둘째', character_order: 1, character_details: '둘째 설정' },
      {
        id: C1,
        character_name: '첫째',
        character_order: 0,
        is_main_character: true,
        character_details: '첫째 설정'
      }
    ],
    [O + '/api/works/' + W + '/characters/' + C1 + '/images']: [{ id: 'i1' }, { id: 'i2' }],
    [O + '/api/works/' + W + '/characters/' + C2 + '/images']: [],
    [O + '/api/works/' + W + '/translations']: {
      success: true,
      items: [
        { language_code: 'ko', is_source: true, exists: true, status: 'draft', stale: false },
        { language_code: 'en', is_source: false, exists: false, status: null, stale: false }
      ]
    },
    [O + '/api/works/' + W + '/translations/en']: {
      success: true,
      item: {
        language_code: 'en',
        exists: true,
        status: 'draft',
        stale: true,
        work: { title: 'Test', scenario_settings: 'Main', lorebook: [], start_scenarios: [] },
        characters: []
      }
    },
    ...extra
  }
  const calls: string[] = []
  const read: WorkFetch = async (url) => {
    calls.push(url)
    if (!edenWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE')
    return url in routes ? ok(routes[url]) : new Response('no', { status: 404 })
  }
  return { read, calls }
}

describe('에덴 작품 읽기', () => {
  it('허용 주소: 작품 읽기 주소만 통과한다', () => {
    expect(workReadAllowed('eden', O + '/api/user/works')).toBe(true)
    expect(workReadAllowed('eden', O + '/api/works/' + W)).toBe(true)
    expect(workReadAllowed('eden', O + '/api/works/' + W + '/translations/zh-TW')).toBe(true)
    // 다른 주소, 다른 출처, 꼬리표가 붙은 주소는 막는다
    expect(workReadAllowed('eden', O + '/api/user/me')).toBe(false)
    expect(workReadAllowed('eden', O + '/api/works/' + W + '?language=en')).toBe(false)
    expect(workReadAllowed('eden', O + '/api/works/' + W + '/../../user/me')).toBe(false)
    expect(workReadAllowed('eden', 'https://evil.example/api/works/' + W)).toBe(false)
    expect(workReadAllowed('eden', 'https://user@www.eden-chat.com/api/user/works')).toBe(false)
    expect(workReadAllowed('babe', O + '/api/user/works')).toBe(false)
  })

  it('목록: 번호 없는 항목은 버리고 공통 이름으로 옮긴다', async () => {
    const { read } = fake()
    const works = await edenWorks.list(read)
    expect(works).toHaveLength(2)
    expect(works[0]).toEqual({
      id: W,
      title: '시험 작품',
      visibility: 'private',
      status: 'draft',
      updatedAt: null,
      characters: 2
    })
  })

  it('작품: 캐릭터를 순서대로 읽고 이미지 수를 붙인다', async () => {
    const { read, calls } = fake()
    const body = edenWorks.normalize(await edenWorks.readRaw(read, W.toUpperCase()))
    expect(body.fields.main).toBe('메인 프롬프트')
    expect(body.fields.creator_comment).toBe('')
    expect(body.lorebook[0]).toMatchObject({
      title: '☀️ 일상',
      keys: '학교, 교실',
      offKeys: ['밤']
    })
    expect(body.startScenarios[0]).toMatchObject({
      title: '기본',
      isDefault: true,
      content: '시작 본문'
    })
    expect(body.characters.map((c) => [c.name, c.isMain, c.imageCount])).toEqual([
      ['첫째', true, 2],
      ['둘째', false, 0]
    ])
    expect(calls).toHaveLength(4)
  })

  it('작품 번호·언어 코드 모양이 틀리면 요청하지 않는다', async () => {
    const { read, calls } = fake()
    await expect(edenWorks.readRaw(read, '../user/me')).rejects.toThrow('BAD_WORK_ID')
    await expect(edenWorks.readEditionRaw!(read, W, 'en/../x')).rejects.toThrow('BAD_LANGUAGE')
    expect(calls).toHaveLength(0)
  })

  it('로그인이 풀렸으면 LOGIN_REQUIRED', async () => {
    const read: WorkFetch = async () => new Response('{}', { status: 401 })
    await expect(edenWorks.list(read)).rejects.toThrow('LOGIN_REQUIRED')
    expect(toolMessage(new Error('LOGIN_REQUIRED'))).toContain('로그인')
  })
})

describe('작품 도구', () => {
  function tools(): {
    run: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>
    calls: string[]
    snaps: string[]
  } {
    const { read, calls } = fake()
    const snaps: string[] = []
    const all = createWorkTools({
      reader: () => read,
      writer: () => async () => new Response('{}', { status: 500 }),
      readFile: async () => '',
      snapshot: async (platform, name) => {
        snaps.push(platform + '/' + name)
        return 'C:/snap/' + name + '.json'
      }
    })
    return {
      calls,
      snaps,
      run: (name, args = {}) =>
        all.find((t) => t.name === name)!.run(args) as Promise<Record<string, unknown>>
    }
  }

  it('사람이 부르는 이름으로도 찾는다', () => {
    expect(workAdapter('에덴').id).toBe('eden')
    expect(workAdapter(' Eden ').id).toBe('eden')
    // 우마이·챗플은 2026-11-10에 연결부가 생겼다. 없는 곳은 여전히 거절한다
    expect(workAdapter('우마이').id).toBe('uumai')
    expect(() => workAdapter('없는사이트')).toThrow('UNKNOWN_SITE')
  })

  it('works_list: 제목 검색', async () => {
    const t = tools()
    const all = await t.run('works_list', { site: '에덴' })
    expect(all.count).toBe(2)
    const one = await t.run('works_list', { site: 'eden', query: '시험' })
    expect(one.count).toBe(1)
  })

  it('work_read: 개요만 주고, 고른 칸만 본문을 준다. 글자 수는 사이트 기준(이모지 2)', async () => {
    const t = tools()
    const out = await t.run('work_read', { site: 'eden', work_id: W, fields: ['description'] })
    expect(out.content).toEqual({ description: '소개 🌸' })
    expect((out.field_lengths as Record<string, number>).description).toBe(5)
    expect(out.lorebook).toEqual([
      { index: 0, title: '☀️ 일상', keys: '학교, 교실', mode: 'keyword', length: 5 }
    ])
    expect(out.snapshot).toBe('C:/snap/' + W + '.json')
    expect(t.snaps).toEqual(['eden/' + W])
    await expect(
      t.run('work_read', { site: 'eden', work_id: W, fields: ['nope'] })
    ).rejects.toThrow('BAD_FIELD')
  })

  it('로어북·시작 상황·캐릭터는 방금 읽은 작품을 다시 내려받지 않는다', async () => {
    const t = tools()
    await t.run('work_read', { site: 'eden', work_id: W })
    const before = t.calls.length
    const lore = await t.run('lorebook_read', { site: 'eden', work_id: W, indexes: [0] })
    expect((lore.entries as { content: string }[])[0].content).toBe('로어 본문')
    await t.run('start_scenarios_read', { site: 'eden', work_id: W })
    await t.run('characters_read', { site: 'eden', work_id: W })
    expect(t.calls.length).toBe(before)
    await expect(
      t.run('lorebook_read', { site: 'eden', work_id: W, indexes: [9] })
    ).rejects.toThrow('BAD_INDEX')
  })

  it('언어 판본: 목록과 판본 읽기', async () => {
    const t = tools()
    const list = await t.run('editions_list', { site: 'eden', work_id: W })
    expect((list.editions as { language: string }[]).map((e) => e.language)).toEqual(['ko', 'en'])
    const en = await t.run('edition_read', {
      site: 'eden',
      work_id: W,
      language: 'en',
      fields: ['main']
    })
    expect(en).toMatchObject({
      language: 'en',
      exists: true,
      stale: true,
      content: { main: 'Main' }
    })
  })
})

type Obj = Record<string, unknown>
const entry = (title: string, key: string, extra: Obj = {}): Obj => ({
  title,
  key,
  value: title + ' 본문',
  triggerMode: 'keyword',
  offKeywords: [],
  turnRange: 5,
  offTurnRange: 5,
  ...extra
})
const rawWork = (work: Obj = {}, characters: Obj[] = []): Obj => ({
  work: {
    id: W,
    title: '작품',
    scenario_settings: '메인',
    visibility: 'public',
    status: 'active',
    lorebook: [],
    start_scenarios: [],
    ...work
  },
  characters,
  images: {}
})
// work_plan이 전체 교체 입력을 바꾸는 모양: 주지 않은 발동 방식·턴 값은 null, 끄는 키워드는 빈 목록
const whole = (title: string, keys: string, extra: Obj = {}): Obj => ({
  title,
  keys,
  content: title + ' 새 본문',
  mode: null,
  offKeys: [],
  turnRange: null,
  offTurnRange: null,
  ...extra
})
const apply = (raw: Obj, changes: Obj): Obj => edenWorks.applyChanges!(raw, changes) as Obj
const loreOf = (out: Obj): Obj[] => (out.work as Obj).lorebook as Obj[]

describe('에덴 저장: 바꾸려던 칸만 바뀐다', () => {
  it('칸 이름이 상속 속성(constructor 등)이면 BAD_FIELD', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty'])
      expect(() => apply(rawWork(), { fields: { [name]: 'x' } })).toThrow('BAD_FIELD')
    expect(apply(rawWork(), { fields: { subtitle: '새 부제' } }).work).toMatchObject({
      subtitle: '새 부제'
    })
  })

  it('캐릭터: 고치기는 지우기·더하기 전 번호 기준이다', () => {
    const raw = rawWork({}, [
      { id: C1, character_name: 'A', character_details: 'a', is_main_character: false },
      { id: C2, character_name: 'B', character_details: 'b', is_main_character: true },
      { id: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeee3', character_name: 'C', character_details: 'c' }
    ])
    // 0번(A)을 지우고 1번(B)을 고친다. 지운 뒤 번호로 고치면 C가 고쳐진다.
    const both = apply(raw, { charactersRemove: [0], characters: [{ index: 1, details: 'b3' }] })
    expect((both.characters as Obj[]).map((c) => [c.character_name, c.character_details])).toEqual([
      ['B', 'b3'],
      ['C', 'c']
    ])
  })

  it('로어북 검사는 바뀌었거나 새로 더한 항목만 본다', () => {
    const raw = rawWork({
      lorebook: [
        entry('빈 키', ''),
        { ...entry('빈 내용', 'k'), value: '' },
        entry('멀쩡', '키')
      ]
    })
    // 옛 문제 항목이 있어도 상관없는 저장은 막히지 않고, 옛 값은 그대로 간다
    const same = apply(raw, { fields: { description: '소개만' } })
    expect(loreOf(same)).toEqual(loreOf(raw))
    expect(loreOf(apply(raw, { lorebookPatch: [{ index: 2, content: '고침' }] }))).toHaveLength(3)
    expect(loreOf(apply(raw, { lorebookAdd: [whole('새', '새키')] }))).toHaveLength(4)
    expect(loreOf(apply(raw, { lorebookRemove: [0, 1] }))).toHaveLength(1)
    // 문제를 만든 칸을 바꾸지 않은 고치기는 막지 않는다 (제목만 고치기)
    expect(() => apply(raw, { lorebookPatch: [{ index: 0, title: '이름만' }] })).not.toThrow()
    expect(() => apply(raw, { lorebookPatch: [{ index: 1, title: '이름만' }] })).not.toThrow()
    // 새 항목과, 문제가 되는 칸을 바꾼 항목은 여전히 검사한다
    expect(() => apply(raw, { lorebookAdd: [whole('새', '')] })).toThrow('BAD_LOREBOOK')
    expect(() => apply(raw, { lorebook: [whole('전체', '')] })).toThrow('BAD_LOREBOOK')
    expect(() => apply(raw, { lorebookPatch: [{ index: 2, keys: '' }] })).toThrow('BAD_LOREBOOK')
    expect(() => apply(raw, { lorebookPatch: [{ index: 2, content: ' ' }] })).toThrow(
      'BAD_LOREBOOK'
    )
    expect(() => apply(raw, { lorebookPatch: [{ index: 1, content: '' }] })).not.toThrow()
    expect(() => apply(raw, { lorebookPatch: [{ index: 1, content: '  ' }] })).toThrow(
      'BAD_LOREBOOK'
    )
  })

  it('로어북 전체 교체: 옛 항목을 그대로 다시 보내도 막히지 않는다 (키 없는 키워드 항목·빈 내용 항목)', () => {
    const raw = rawWork({
      lorebook: [entry('빈 키', ''), { ...entry('빈 내용', 'k'), value: '' }, entry('멀쩡', '키')]
    })
    const same = loreOf(raw).map((e) => ({
      title: e.title as string,
      keys: e.key as string,
      content: e.value as string,
      mode: null,
      offKeys: [],
      turnRange: null,
      offTurnRange: null
    }))
    expect(loreOf(apply(raw, { lorebook: same }))).toEqual(loreOf(raw))
    // 내용만 고친 항목은, 키 없는 키워드 문제가 옛 값 그대로여도 막히지 않는다. 내용을 비우면 막힌다.
    const edited = same.map((e, i) => (i === 0 ? { ...e, content: '고침' } : e))
    expect(loreOf(apply(raw, { lorebook: edited }))[0]).toMatchObject({ value: '고침', key: '' })
    const emptied = same.map((e, i) => (i === 0 ? { ...e, content: '' } : e))
    expect(() => apply(raw, { lorebook: emptied })).toThrow('BAD_LOREBOOK')
  })

  it('로어북 전체 교체: 삭제된 옛 항목의 설정을 다른 항목이 물려받지 않는다', () => {
    const raw = rawWork({
      lorebook: [
        entry('A', '', { triggerMode: 'always', turnRange: 1 }),
        entry('B', 'b', { turnRange: 9, offKeywords: ['밤'] }),
        entry('C', 'c')
      ]
    })
    // A 삭제 + B 이름 변경: 이름 바뀐 B2는 A의 always를 받지 않는다 (새 항목이라 기본값)
    const a = loreOf(apply(raw, { lorebook: [whole('B2', 'b'), whole('C', 'c')] }))
    expect(a[0]).toEqual(entry('B2', 'b', { value: 'B2 새 본문' }))
    expect(a[1]).toMatchObject({ title: 'C', triggerMode: 'keyword', turnRange: 5 })
    // 이어 줄 짝이 하나도 없고 옛 항목이 더 많은 경우도 마찬가지
    const b = loreOf(apply(raw, { lorebook: [whole('B2', 'b'), whole('C2', 'c')] }))
    expect(b[0]).toMatchObject({ triggerMode: 'keyword', turnRange: 5, offKeywords: [] })
    expect(b[1]).toMatchObject({ triggerMode: 'keyword', turnRange: 5 })
    // 끝 항목을 지우면서 이름을 바꾼 경우도 어느 쪽이 지워졌는지 알 수 없어 새 항목이다
    const c = loreOf(apply(raw, { lorebook: [whole('A', ''), whole('B2', 'b')] }))
    expect(c[0]).toMatchObject({ triggerMode: 'always', turnRange: 1 })
    expect(c[1]).toMatchObject({ triggerMode: 'keyword', turnRange: 5, offKeywords: [] })
    // 지워진 것이 없는 순수 이름 고치기·이름 고치기 + 끝에 새 항목은 옛 설정을 잇는다
    const d = loreOf(apply(raw, { lorebook: [whole('A', ''), whole('B2', 'b'), whole('C', 'c')] }))
    expect(d[1]).toMatchObject({ title: 'B2', turnRange: 9, offKeywords: ['밤'] })
    const e = loreOf(
      apply(raw, { lorebook: [whole('A', ''), whole('B2', 'b'), whole('C', 'c'), whole('D', 'd')] })
    )
    expect(e[1]).toMatchObject({ title: 'B2', turnRange: 9 })
    expect(e[3]).toMatchObject({ triggerMode: 'keyword', turnRange: 5 })
  })

  it('로어북 전체 교체: 제목이 같은 항목은 내용이 같은 옛 항목과 짝지어 순서를 바꿔도 설정이 딸려 가지 않는다', () => {
    const raw = rawWork({
      lorebook: [
        entry('같은 이름', 'x', { value: '첫째', turnRange: 1 }),
        entry('같은 이름', 'x', { value: '둘째', turnRange: 2 })
      ]
    })
    const out = loreOf(
      apply(raw, {
        lorebook: [
          whole('같은 이름', 'x', { content: '둘째' }),
          whole('같은 이름', 'x', { content: '첫째' })
        ]
      })
    )
    expect(out.map((e) => [e.value, e.turnRange])).toEqual([
      ['둘째', 2],
      ['첫째', 1]
    ])
  })

  it('로어북 전체 교체: 키워드를 적지 않았으면 짝지은 옛 항목의 키워드를 지우지 않는다', () => {
    const raw = rawWork({ lorebook: [entry('일반', '옛키', { turnRange: 7 })] })
    const noKeys = { given: ['title', 'content'], title: '일반', content: '새 본문' }
    const [out] = loreOf(apply(raw, { lorebook: [whole('일반', '', noKeys)] }))
    expect(out).toMatchObject({ key: '옛키', value: '새 본문', turnRange: 7 })
    // 적었으면 빈 값이어도 받은 값을 쓴다 (always로 바꾸는 경우)
    const [set] = loreOf(
      apply(raw, {
        lorebook: [whole('일반', '', { given: ['title', 'keys', 'content', 'mode'], mode: 'always' })]
      })
    )
    expect(set).toMatchObject({ key: '', triggerMode: 'always' })
  })

  it('캐릭터 더하기: 새 캐릭터 본문에도 scenario_settings가 빈 글로 실린다', () => {
    const raw = rawWork({}, [{ id: C1, character_name: '주연', is_main_character: true }])
    const next = apply(raw, { charactersAdd: [{ name: '셋째', details: '설정' }] })
    const added = (edenSaveBody(next).characters as Obj[])[1]
    expect(added).toMatchObject({
      character_name: '셋째',
      character_details: '설정',
      character_info: '',
      is_main_character: false,
      scenario_settings: '',
      start_scenario: null,
      character_order: 1,
      images: []
    })
    // 다른 캐릭터와 같은 칸 구성이다
    const [first] = edenSaveBody(next).characters as Obj[]
    expect(Object.keys(added).sort()).toEqual(Object.keys(first).sort())
  })

  it('저장할 모양으로 맞춘 원본: null → 빈 글 변환이 보내려던 원본에도 있다 (저장 뒤 원본 견주기)', () => {
    const raw = rawWork({ subtitle: null, description: 'd', creator_comment: '' }, [
      { id: C1, character_name: '주연', is_main_character: true, scenario_settings: null }
    ])
    const next = apply(raw, { fields: { description: '새 소개' } })
    const sent = edenSaveBody(next)
    // 보내려던 원본(next)과 실제 본문이 같은 값이라 서버가 그대로 돌려주면 차이가 없다
    expect((next.work as Obj).subtitle).toBe('')
    expect((next.work as Obj).creator_comment).toBeNull()
    expect((next.characters as Obj[])[0].scenario_settings).toBe('')
    expect(sent).toMatchObject({ subtitle: '', creator_comment: null })
    expect((sent.characters as Obj[])[0].scenario_settings).toBe('')
    // 판본 겹침은 판본 저장 본문이 따로 정해지므로 건드리지 않는다
    const view = edenWorks.editionView!(raw, { language_code: 'en', exists: true, work: {}, characters: [] })
    const edited = edenWorks.applyEditionChanges!(view, { fields: { description: 'x' } }) as Obj
    expect((edited.work as Obj).subtitle).toBeNull()
    expect((edited.characters as Obj[])[0].scenario_settings).toBeNull()
  })

  it('판본 저장도 손대지 않은 옛 로어북 항목 때문에 막히지 않는다', () => {
    const view = edenWorks.editionView!(
      rawWork({ lorebook: [entry('빈 키', '')] }),
      { language_code: 'en', exists: true, work: {}, characters: [] }
    )
    expect(() =>
      edenWorks.applyEditionChanges!(view, { fields: { description: 'x' } })
    ).not.toThrow()
  })

  it('로어북 전체 교체: 제목이 같은 옛 항목의 설정을 물려받고, 짝 없는 새 항목은 기본값', () => {
    const raw = rawWork({
      lorebook: [
        entry('항상', '', {
          triggerMode: 'always',
          turnRange: 3,
          offTurnRange: 9,
          offKeywords: ['밤'],
          hidden: 'x'
        }),
        entry('일반', '일반키', { turnRange: 7 })
      ]
    })
    // 맨 앞에 새 항목을 끼우고 순서를 바꿔도 설정이 자리 번호로 딸려 가지 않는다
    const out = loreOf(
      apply(raw, {
        lorebook: [whole('끼움', '끼움키'), whole('일반', '일반키'), whole('항상', '')]
      })
    )
    expect(out[0]).toEqual(
      entry('끼움', '끼움키', { value: '끼움 새 본문' }) // 기본 keyword·5·5, 옛 항목에서 아무것도 안 받는다
    )
    expect(out[1]).toMatchObject({ title: '일반', triggerMode: 'keyword', turnRange: 7 })
    expect(out[2]).toMatchObject({
      title: '항상',
      value: '항상 새 본문',
      triggerMode: 'always',
      turnRange: 3,
      offTurnRange: 9,
      offKeywords: ['밤'],
      hidden: 'x'
    })
    // 준 값은 옛 값보다 우선한다
    const given = loreOf(
      apply(raw, {
        lorebook: [whole('항상', '키', { mode: 'keyword', turnRange: 2, offKeys: ['낮'] })]
      })
    )
    expect(given[0]).toMatchObject({
      triggerMode: 'keyword',
      turnRange: 2,
      offTurnRange: 9,
      offKeywords: ['낮']
    })
    // 제목만 고친 제자리 항목은 같은 자리의 옛 항목을 잇는다
    const renamed = loreOf(apply(raw, { lorebook: [whole('이름 바뀜', '', {}), whole('일반', '일반키')] }))
    expect(renamed[0]).toMatchObject({ triggerMode: 'always', turnRange: 3 })
  })

  it('로어북 일부 고치기: 안 건드린 칸의 null·빈 값에 기본값을 채우지 않는다', () => {
    const raw = rawWork({
      lorebook: [{ title: '옛', key: '키', value: '본문', triggerMode: 'keyword', turnRange: null }]
    })
    const [out] = loreOf(apply(raw, { lorebookPatch: [{ index: 0, title: '옛 2' }] }))
    expect(out).toEqual({
      title: '옛 2',
      key: '키',
      value: '본문',
      triggerMode: 'keyword',
      turnRange: null
    })
  })
})

describe('에덴 로어북 전체 교체: given(적어 준 칸)', () => {
  const old = (): Obj =>
    rawWork({
      lorebook: [
        entry('항상', '', {
          triggerMode: 'always',
          turnRange: 3,
          offTurnRange: 9,
          offKeywords: ['밤'],
          hidden: 'x'
        })
      ]
    })
  const only = ['title', 'keys', 'content']

  it('given에 없는 칸은 받은 값이 있어도 옛 값을 그대로 둔다', () => {
    const [out] = loreOf(
      apply(old(), {
        lorebook: [
          whole('항상', '', {
            given: only,
            mode: 'keyword',
            offKeys: ['낮'],
            turnRange: 1,
            offTurnRange: 2
          })
        ]
      })
    )
    expect(out).toMatchObject({
      value: '항상 새 본문',
      triggerMode: 'always',
      offKeywords: ['밤'],
      turnRange: 3,
      offTurnRange: 9,
      hidden: 'x'
    })
  })

  it('given에 있는 칸은 빈 값이어도 받은 값으로 바꾼다', () => {
    const [out] = loreOf(
      apply(old(), {
        lorebook: [whole('항상', '', { given: [...only, 'offKeys'], offKeys: [] })]
      })
    )
    expect(out).toMatchObject({ offKeywords: [], triggerMode: 'always', turnRange: 3 })
    const [set] = loreOf(
      apply(old(), {
        lorebook: [
          whole('항상', '키', {
            given: [...only, 'mode', 'turnRange', 'offTurnRange'],
            mode: 'keyword',
            turnRange: 0,
            offTurnRange: 2
          })
        ]
      })
    )
    expect(set).toMatchObject({
      triggerMode: 'keyword',
      turnRange: 0,
      offTurnRange: 2,
      offKeywords: ['밤']
    })
  })

  it('짝 없는 새 항목은 given이 있어도 기본값으로 만든다', () => {
    const out = loreOf(
      apply(old(), {
        lorebook: [whole('항상', '', { given: only }), whole('새로', '새키', { given: only })]
      })
    )
    expect(out[0]).toMatchObject({ triggerMode: 'always', turnRange: 3 })
    expect(out[1]).toEqual(entry('새로', '새키', { value: '새로 새 본문' }))
  })

  it('given이 없는 옛 호출은 지금 동작 그대로: 받은 값은 쓰고 빈 끄는 키워드는 옛 값을 남긴다', () => {
    const [out] = loreOf(apply(old(), { lorebook: [whole('항상', '', { turnRange: 8 })] }))
    expect(out).toMatchObject({ turnRange: 8, offTurnRange: 9, offKeywords: ['밤'] })
  })
})

describe('에덴 읽기: 기능 표·숨은 설정·못 읽는 칸', () => {
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

  it('features: 22개 열쇠를 모두 담고 note는 40자 이내', () => {
    const features = edenWorks.features!
    expect(Object.keys(features).sort()).toEqual([...KEYS].sort())
    for (const f of Object.values(features)) {
      expect(['yes', 'no', 'unknown']).toContain(f.site)
      expect(['yes', 'no', 'partial']).toContain(f.read)
      expect(['yes', 'no', 'partial', 'blocked']).toContain(f.write)
      expect(['yes', 'no', 'partial']).toContain(f.verified)
      expect(f.note!.length).toBeGreaterThan(0)
      expect(f.note!.length).toBeLessThanOrEqual(40)
    }
    // 코드가 하는 것과 맞춘 곳
    expect(features.tags).toMatchObject({ read: 'yes', write: 'partial' })
    expect(features.start_scenarios.write).toBe('partial')
    expect(features.user_persona.read).toBe('partial')
  })

  const sample = (like: number): Obj =>
    rawWork(
      {
        work_type: 'original',
        genre: ['로맨스'],
        tags: ['가', '나'],
        categories: ['분류'],
        hashtags: ['#해시'],
        is_nsfw: true,
        template_type: 'default',
        prompt_version: 'v2',
        image_source_mode: 'mixed',
        cover_image_url: 'https://img.example/c.webp?token=SECRET',
        default_image_url: '',
        selected_scenario_id: 3,
        selected_preset_id: null,
        recommended_personas: [{ name: '가' }, { name: '나' }],
        character_presets: [],
        external_images: [{}, {}, {}],
        first_published_at: '2026-01-01T00:00:00Z',
        created_at: '2025-12-31T00:00:00Z',
        content_updated_at: '2026-02-01T00:00:00Z',
        update_announced_at: null,
        total_messages: 99,
        chat_count: 98,
        like_count: like,
        is_liked: true,
        has_conversation: true,
        creator: { nickname: '비밀닉' },
        creator_id: 'user-secret'
      },
      [
        {
          id: C1,
          character_name: 'A',
          lorebook: [{}, {}],
          mood_images: [{}],
          profile_image_asset_url: 'https://img.example/p.webp',
          scenario_settings: '캐릭터 설정 본문',
          character_description: null,
          start_scenario: 2
        },
        {
          id: C2,
          character_name: 'B',
          lorebook: null,
          mood_images: [],
          profile_image_asset_url: null,
          scenario_settings: null,
          character_description: '',
          start_scenario: null
        }
      ]
    )

  it('extras: 원본에 있는 설정만, 짧은 값은 그대로 긴 것은 개수·길이로', () => {
    const body = edenWorks.normalize(sample(5))
    expect(body.extras).toEqual({
      work_type: 'original',
      genre: ['로맨스'],
      tags: ['가', '나'],
      categories: ['분류'],
      hashtags: ['#해시'],
      is_adult: true,
      template_type: 'default',
      prompt_version: 'v2',
      image_source_mode: 'mixed',
      has_cover_image: true,
      has_default_image: false,
      selected_scenario_id: 3,
      selected_preset_id: null,
      recommended_persona_count: 2,
      preset_count: 0,
      external_image_count: 3,
      first_published_at: '2026-01-01T00:00:00Z',
      created_at: '2025-12-31T00:00:00Z',
      content_updated_at: '2026-02-01T00:00:00Z',
      update_announced_at: null,
      character_lorebook_entry_count: 2,
      character_mood_image_count: 1,
      characters_with_profile_image: 1,
      characters_with_scenario_settings: 1,
      characters_with_description: 0,
      characters_with_start_scenario: 1
    })
    // 주소의 토큰·계정 정보·본문은 어디에도 없다
    const dump = JSON.stringify(body.extras)
    for (const leak of ['SECRET', '비밀닉', 'user-secret', '캐릭터 설정 본문', 'img.example'])
      expect(dump).not.toContain(leak)
  })

  it('extras: 원본에 없는 칸은 지어내지 않고, 긴 값은 길이·개수만 싣는다', () => {
    expect(edenWorks.normalize(rawWork()).extras).toEqual({})
    const long = edenWorks.normalize(
      rawWork({
        work_type: 'x'.repeat(100),
        tags: Array.from({ length: 21 }, (_, i) => 't' + i),
        categories: ['y'.repeat(81)],
        recommended_personas: null
      })
    )
    expect(long.extras).toEqual({ work_type_length: 100, tags_count: 21, categories_count: 1 })
  })

  it('extras: 읽을 때마다 달라지는 통계는 싣지 않아 본문이 같다 (계획이 낡은 것으로 보이지 않는다)', () => {
    const a = edenWorks.normalize(sample(5))
    const b = edenWorks.normalize({
      ...sample(6),
      work: { ...(sample(6).work as Obj), total_messages: 100, chat_count: 99, is_liked: false }
    })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    for (const key of ['like_count', 'total_messages', 'chat_count', 'is_liked'])
      expect(a.extras).not.toHaveProperty(key)
    // 읽을 때마다 달라지는 시각(updated_at 등)과 대화 여부도 싣지 않는다. 내용 저장 시각만 있다.
    const c = edenWorks.normalize({
      ...sample(5),
      work: {
        ...(sample(5).work as Obj),
        updated_at: '2030-01-01T00:00:00Z',
        last_chat_at: '2030-01-02T00:00:00Z',
        has_conversation: false,
        view_count: 12345
      }
    })
    expect(JSON.stringify(c.extras)).toBe(JSON.stringify(a.extras))
    expect(a.extras).toHaveProperty('content_updated_at', '2026-02-01T00:00:00Z')
    // 내용을 저장해 content_updated_at이 바뀌면 그때만 본문이 달라진다 (다른 곳에서 저장한 것이라 낡은 계획이 맞다)
    const d = edenWorks.normalize({
      ...sample(5),
      work: { ...(sample(5).work as Obj), content_updated_at: '2026-03-01T00:00:00Z' }
    })
    expect(JSON.stringify(d)).not.toBe(JSON.stringify(a))
  })

  it('unsupported: 읽지 못하는 칸을 적고, extras로 읽게 된 것은 뺀다', () => {
    const body = edenWorks.normalize(rawWork())
    expect(body.unsupported).toEqual(
      expect.arrayContaining(['배경음', '캐릭터 음성', '댓글', '통계(대화·좋아요 수)'])
    )
    // 개수·유무만 읽는 칸의 "내용은 못 읽음"도 적혀 있다
    const joined = body.unsupported!.join('|')
    for (const name of ['추천 페르소나', '프리셋', '캐릭터별 로어북', '감정 이미지', '외부 이미지', '캐릭터 설명'])
      expect(joined).toContain(name)
    // 읽는 칸은 항목 이름 어디에도 없다 (항목이 "…(개수만)"처럼 길어도 걸리게 부분 글로 본다)
    for (const name of ['태그', '분류', '성인 표시', '등장인물'])
      expect(body.unsupported!.some((u) => u.includes(name))).toBe(false)
    expect(body.unsupported!.some((u) => u.startsWith('로어북'))).toBe(false)
  })

  it('판본 읽기는 extras·unsupported를 붙이지 않는다', () => {
    const edition = edenWorks.normalizeEdition!({
      language_code: 'en',
      exists: true,
      work: { title: 'T', tags: ['a'] },
      characters: []
    })
    expect(edition.extras).toBeUndefined()
    expect(edition.unsupported).toBeUndefined()
  })

  it('저장 본문은 extras·unsupported 때문에 달라지지 않는다', () => {
    const raw = sample(5)
    const before = JSON.stringify(edenSaveBody(raw))
    edenWorks.normalize(raw)
    expect(JSON.stringify(edenSaveBody(raw))).toBe(before)
    expect(before).not.toContain('is_adult')
  })
})

describe('에덴 저장 본문: 값이 있으면 그대로, 없거나 null이면 예전부터 보내던 기본값', () => {
  it('없거나 null인 칸은 예전 본문과 같은 기본값으로 채운다', () => {
    const body = edenSaveBody(
      rawWork(
        {
          subtitle: null,
          template_type: null,
          work_type: null,
          tags: null,
          is_nsfw: null,
          selected_scenario_id: null
        },
        [{ id: C1, character_name: '주연', is_main_character: true }]
      )
    )
    expect(body).toMatchObject({
      subtitle: '', // null로 온 글 칸은 확인된 저장대로 빈 글
      description: '',
      template_type: 'default',
      work_type: 'original',
      prompt_version: 'v1',
      image_source_mode: 'mixed',
      tags: [],
      genre: [],
      categories: [],
      hashtags: [],
      lorebook: [],
      start_scenarios: [],
      character_presets: [],
      recommended_personas: [],
      is_nsfw: false,
      selected_scenario_id: null,
      selected_preset_id: null,
      cover_image_url: null,
      creator_comment: null,
      visibility: 'public',
      status: 'active'
    })
    const [c] = body.characters as Obj[]
    expect(c).toMatchObject({
      id: C1,
      character_name: '주연',
      is_main_character: true,
      character_info: '',
      character_details: '',
      scenario_settings: '',
      start_scenario: null,
      template_type: 'default' // 작품 값(기본값 default)
    })
  })

  it('공개 상태는 기본값이 없다: 모르면 저장 본문을 만들지 않는다', () => {
    expect(() => edenSaveBody(rawWork({ visibility: null }))).toThrow('WORK_SHAPE')
    expect(() => edenSaveBody(rawWork({ status: undefined }))).toThrow('WORK_SHAPE')
    expect(edenSaveBody(rawWork({ visibility: 'private', status: 'draft' }))).toMatchObject({
      visibility: 'private',
      status: 'draft'
    })
  })

  it('원본에 있는 값은 기본값으로 덮지 않는다 (빈 값·false·빈 목록 포함)', () => {
    const body = edenSaveBody(
      rawWork(
        {
          subtitle: '',
          description: '소개',
          tags: [],
          is_nsfw: false,
          work_type: 'derivative',
          selected_scenario_id: 0
        },
        [{ id: C1, character_name: '주연', scenario_settings: '', is_main_character: true }]
      )
    )
    expect(body).toMatchObject({
      subtitle: '',
      description: '소개',
      tags: [],
      is_nsfw: false,
      work_type: 'derivative',
      selected_scenario_id: 0
    })
  })

  it('원본에 있는 값은 그대로: 구작 v2·성인 표시·캐릭터별 템플릿', () => {
    const body = edenSaveBody(
      rawWork(
        {
          prompt_version: 'v2',
          image_source_mode: 'external',
          work_type: 'derivative',
          template_type: 'default',
          is_nsfw: true,
          genre: ['g'],
          cover_image_url: 'https://img.example/c.webp'
        },
        [
          { id: C1, character_name: 'A', character_info: '', scenario_settings: null },
          { id: C2, character_name: 'B', template_type: 'custom', start_scenario: 4 }
        ]
      )
    )
    expect(body).toMatchObject({
      prompt_version: 'v2',
      image_source_mode: 'external',
      work_type: 'derivative',
      is_nsfw: true,
      genre: ['g'],
      cover_image_url: 'https://img.example/c.webp'
    })
    const [a, b] = body.characters as Obj[]
    expect(a).toMatchObject({
      character_info: '',
      scenario_settings: '',
      template_type: 'default'
    })
    expect(b).toMatchObject({ template_type: 'custom', start_scenario: 4 })
  })

  it('제목·캐릭터 이름을 모르면 빈 값으로 저장하지 않고 멈춘다', () => {
    expect(() => edenSaveBody(rawWork({ title: undefined }))).toThrow('WORK_SHAPE')
    expect(() => edenSaveBody(rawWork({}, [{ id: C1, character_name: null }]))).toThrow(
      'WORK_SHAPE'
    )
  })

  it('새 작품 본문의 칸 구성은 그대로다 (기본값은 새 작품에서만 정한다)', () => {
    const body = edenCreateBody({
      title: '새',
      main: '메인',
      adult: false,
      characters: [{ name: '주연' }]
    })
    expect(Object.keys(body).sort()).toEqual(
      [
        'categories',
        'character_presets',
        'characters',
        'creator_comment',
        'description',
        'genre',
        'hashtags',
        'image_source_mode',
        'is_nsfw',
        'lorebook',
        'prompt_version',
        'recommended_personas',
        'scenario_settings',
        'selected_preset_id',
        'selected_scenario_id',
        'start_scenarios',
        'status',
        'subtitle',
        'tags',
        'template_type',
        'title',
        'visibility',
        'work_type'
      ].sort()
    )
    expect(body).toMatchObject({
      template_type: 'default',
      prompt_version: 'v1',
      image_source_mode: 'mixed',
      work_type: 'original',
      creator_comment: null,
      selected_preset_id: null
    })
    expect(Object.keys((body.characters as Obj[])[0]).sort()).toEqual(
      [
        'character_details',
        'character_info',
        'character_name',
        'character_order',
        'id',
        'images',
        'is_main_character',
        'scenario_settings',
        'start_scenario',
        'template_type'
      ].sort()
    )
    expect((body.characters as Obj[])[0]).toMatchObject({
      scenario_settings: '',
      start_scenario: null,
      template_type: 'default'
    })
  })
})
