import { describe, expect, it } from 'vitest'
import { babeSaveBody, babeWorks } from '../src/main/works/babe'
import { workAdapter, workReadAllowed, workWriteAllowed } from '../src/main/works/adapters'
import { createWorkTools } from '../src/main/works/tools'
import type { LoreEntry, WorkChanges, WorkFetch, WorkWrite } from '../src/main/works/types'

const W = '11111111-2222-4333-8444-555555555555'
const API = 'https://api.babechatapi.com/ko/api/characters/'
type Obj = Record<string, unknown>

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

function editData(): Obj {
  return {
    version: 3,
    name: '시험 작품',
    description: '소개',
    characterDetails: '캐릭터 설정',
    initialTitle: '기본',
    initialAction: '첫 상황',
    initialMessage: '첫 대사',
    playGuide: '',
    visibility: 'public',
    isAdult: true,
    category: 11,
    hashtags: ['순애'],
    images: [
      { url: 'https://img.example/main.webp', emotion: null, hidden: false, order: 0 },
      { url: 'https://img.example/joy.webp', emotion: 'joy', order: 5 },
      { url: '', emotion: 'sad', hidden: false, order: 6 }
    ],
    date: '2000-01-01',
    jobs: ['학생'],
    likes: ['책'],
    dislikes: [],
    interests: [],
    height: '160',
    weight: '50',
    details: '상세',
    location: '서울',
    replySuggestions: ['안녕', '  '],
    systemPrompt: 'custom',
    targetGender: 'male',
    keywordBooks: [
      { id: 7, title: '로어북 1', content: '로어 본문', keywords: ['학교', '교실'], order: 4 }
    ],
    startingScenarios: [
      {
        id: 9,
        initialTitle: '둘째',
        initialAction: '둘째 상황',
        initialMessage: '둘째 대사',
        playGuide: '안내',
        replySuggestions: ['', '응'],
        order: 0
      }
    ],
    babechatOnly: false,
    tookitOnly: false,
    recommendedModel: 'gemini',
    recommendedConfigMode: 'bulk',
    modelConfigs: [
      { model: 'a', thinkingLevel: 'low', outputLevel: 1 },
      { model: 'b', thinkingLevel: 'low', outputLevel: 1 }
    ],
    creatorKeywordBookLimit: 5
  }
}

/** 베이비챗 흉내: 미리보기는 쓰지 않고, 저장은 버전을 올린다 */
function site(): {
  read: WorkFetch
  write: WorkWrite
  calls: string[]
  sent: Obj[]
  data: Obj
} {
  const state = { calls: [] as string[], sent: [] as Obj[], data: editData() }
  const same = (body: Obj): boolean =>
    JSON.stringify(body) === JSON.stringify(babeSaveBody(state.data))
  const read: WorkFetch = async (url) => {
    if (!babeWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE')
    if (url === API + 'my')
      return ok([
        { id: W, characterId: W, name: '시험 작품', visibility: 'public' },
        { name: '번호 없음' }
      ])
    if (url === API + W + '/edit') return ok(state.data)
    return new Response('no', { status: 404 })
  }
  const write: WorkWrite = async (method, url, body) => {
    if (!babeWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE')
    state.calls.push(method + ' ' + url.replace(API + W, ''))
    const sent = body as Obj
    if (method === 'POST')
      return ok({ baseVersion: state.data.version, version: 4, hasChanges: !same(sent) })
    if (sent.baseVersion !== state.data.version)
      return new Response('{"error":"characterVersionConflict"}', { status: 409 })
    state.sent.push(sent)
    state.data = {
      ...state.data,
      name: sent.name,
      characterDetails: sent.characterDetails,
      initialAction: sent.initialAction,
      keywordBooks: sent.keywordBooks,
      startingScenarios: sent.startingScenarios,
      version: (state.data.version as number) + 1
    }
    return ok({ ok: true })
  }
  return Object.assign(state, { read, write })
}

function tools(s: ReturnType<typeof site>): (name: string, args?: Obj) => Promise<Obj> {
  const all = createWorkTools({
    reader: () => s.read,
    writer: () => s.write,
    snapshot: async () => 'C:/snap.json',
    readFile: async () => ''
  })
  return (name, args = {}) => all.find((t) => t.name === name)!.run(args) as Promise<Obj>
}

describe('베이비챗 작품', () => {
  it('허용 주소: 읽기 둘, 쓰기는 미리보기(POST)·저장(PUT)·삭제(DELETE)뿐이다', () => {
    expect(workReadAllowed('babe', API + 'my')).toBe(true)
    expect(workReadAllowed('babe', API + W + '/edit')).toBe(true)
    expect(workReadAllowed('babe', API + W)).toBe(false)
    expect(workReadAllowed('babe', API + 'my?tab=all')).toBe(false)
    expect(workReadAllowed('babe', 'https://babechat.ai/ko/api/characters/my')).toBe(false)
    expect(workWriteAllowed('babe', 'PUT', API + W + '/edit')).toBe(true)
    expect(workWriteAllowed('babe', 'POST', API + W + '/edit/preview')).toBe(true)
    expect(workWriteAllowed('babe', 'POST', API + W + '/edit')).toBe(false)
    expect(workWriteAllowed('babe', 'PUT', API + W + '/edit/preview')).toBe(false)
    expect(workWriteAllowed('babe', 'DELETE', API + W)).toBe(true)
    expect(workWriteAllowed('babe', 'PUT', API + 'edit/draft')).toBe(false)
    // 새 작품 만들기는 그 주소 하나만 열려 있다
    expect(workWriteAllowed('babe', 'POST', API + 'create')).toBe(true)
    expect(workWriteAllowed('babe', 'POST', API + 'create/draft')).toBe(false)
    expect(workWriteAllowed('babe', 'PUT', API + 'create')).toBe(false)
    expect(workAdapter('바베').id).toBe('babe')
  })

  it('읽기: 캐릭터 설정이 main, 기본 시작 설정이 0번이다', async () => {
    const s = site()
    const run = tools(s)
    expect((await run('works_list', { site: '베이비챗' })).count).toBe(1)
    const out = await run('work_read', { site: 'babe', work_id: W, fields: ['main'] })
    expect(out).toMatchObject({
      title: '시험 작품',
      visibility: 'public',
      updated_at: 'v3',
      content: { main: '캐릭터 설정' },
      characters: []
    })
    expect(out.lorebook).toEqual([
      { index: 0, title: '로어북 1', keys: '학교, 교실', mode: null, length: 5 }
    ])
    expect((out.start_scenarios as Obj[]).map((x) => [x.title, x.is_default])).toEqual([
      ['기본', true],
      ['둘째', false]
    ])
  })

  it('저장 본문: 편집기와 같은 모양으로 옮긴다', () => {
    const body = babeSaveBody(editData())
    expect(body).toMatchObject({
      name: '시험 작품',
      image: 'https://img.example/main.webp',
      tags: ['순애'],
      visibility: 'public',
      systemPrompt: 'custom',
      replySuggestions: ['안녕'],
      details: { jobs: ['학생'], height: '160', details: '상세' },
      modelConfig: { mode: 'bulk', thinkingLevel: 'low', outputLevel: 1 }
    })
    // 감정 이미지는 주소 있는 것만, 순서는 1부터 다시 매긴다
    expect(body.emotionImages).toEqual([
      { url: 'https://img.example/joy.webp', emotion: 'joy', order: 1, hidden: false }
    ])
    expect((body.keywordBooks as Obj[])[0]).toMatchObject({ id: 7, order: 0 })
    expect((body.startingScenarios as Obj[])[0]).toMatchObject({ id: 9, replySuggestions: ['응'] })
    expect('hashtags' in body || 'images' in body || 'version' in body).toBe(false)
    expect(babeSaveBody({ ...editData(), systemPrompt: 'default' }).systemPrompt).toBeUndefined()
    expect(
      babeSaveBody({ ...editData(), recommendedConfigMode: 'individual' }).modelConfig
    ).toMatchObject({ mode: 'individual' })
    expect(() => babeSaveBody({ ...editData(), images: [] })).toThrow('WORK_SHAPE')
  })

  it('저장: 미리보기 뒤 저장하고, 버전 번호와 알림 끔을 같이 보낸다', async () => {
    const s = site()
    const run = tools(s)
    const plan = await run('work_plan', {
      site: 'babe',
      work_id: W,
      fields: { main: '새 설정' },
      lorebook_patch: [{ index: 0, keys: '바다, 모래' }],
      start_scenarios: [
        { index: 0, content: '새 첫 상황' },
        { index: 1, dialogue: '새 둘째 대사' }
      ]
    })
    expect((plan.changes as { where: string }[]).map((c) => c.where)).toEqual([
      'main',
      'lorebook[0] 로어북 1 · keys',
      'start_scenarios[0] 기본 · content',
      'start_scenarios[1] 둘째 · dialogue'
    ])
    expect(s.calls).toHaveLength(0)
    const saved = await run('work_save', { plan_id: plan.plan_id })
    expect(saved).toMatchObject({
      saved: true,
      verified: true,
      visibility: 'public',
      updated_at: 'v4'
    })
    expect(s.calls).toEqual(['POST /edit/preview', 'PUT /edit'])
    expect(s.sent[0]).toMatchObject({
      characterDetails: '새 설정',
      initialAction: '새 첫 상황',
      baseVersion: 3,
      creatorComment: '',
      notifyFollowers: false
    })
    expect((s.sent[0].keywordBooks as Obj[])[0].keywords).toEqual(['바다', '모래'])
    expect((s.sent[0].startingScenarios as Obj[])[0].initialMessage).toBe('새 둘째 대사')
  })

  it('로어북 추가·삭제·전체 교체: 새 항목은 번호 없이, 남는 항목은 번호 그대로 보낸다', async () => {
    const s = site()
    const run = tools(s)
    const add = await run('work_plan', {
      site: 'babe',
      work_id: W,
      lorebook_add: [{ title: '새 로어', keys: '바다, 모래', content: '새 본문' }]
    })
    expect((add.changes as Obj[])[0]).toMatchObject({ where: 'lorebook[1] 새 로어', kind: 'added' })
    expect(await run('work_save', { plan_id: add.plan_id })).toMatchObject({ verified: true })
    expect(s.sent[0].keywordBooks).toEqual([
      { id: 7, title: '로어북 1', content: '로어 본문', keywords: ['학교', '교실'], order: 0 },
      { title: '새 로어', content: '새 본문', keywords: ['바다', '모래'], order: 1 }
    ])

    const remove = await run('work_plan', { site: 'babe', work_id: W, lorebook_remove: [0] })
    expect((remove.changes as Obj[]).some((c) => c.kind === 'removed')).toBe(true)
    await run('work_save', { plan_id: remove.plan_id })
    expect((s.sent[1].keywordBooks as Obj[]).map((b) => b.title)).toEqual(['새 로어'])

    const replace = await run('work_plan', {
      site: 'babe',
      work_id: W,
      lorebook: [
        { title: '하나', keys: 'a', content: '1' },
        { title: '둘', keys: 'b', content: '2' }
      ]
    })
    await run('work_save', { plan_id: replace.plan_id })
    const sent = s.sent[2].keywordBooks as Obj[]
    expect(sent.map((b) => [b.title, b.order, 'id' in b])).toEqual([
      ['하나', 0, false],
      ['둘', 1, false]
    ])
  })

  it('시작 설정 추가·삭제: 새 항목은 번호 없이 보내고 0번(기본)은 지울 수 없다', async () => {
    const s = site()
    const run = tools(s)
    const add = await run('work_plan', {
      site: 'babe',
      work_id: W,
      start_scenarios_add: [{ title: '셋째', content: '셋째 상황', dialogue: '셋째 대사' }]
    })
    expect((add.changes as Obj[])[0]).toMatchObject({ kind: 'added' })
    await run('work_save', { plan_id: add.plan_id })
    expect((s.sent[0].startingScenarios as Obj[])[1]).toEqual({
      initialTitle: '셋째',
      initialAction: '셋째 상황',
      initialMessage: '셋째 대사',
      playGuide: '',
      replySuggestions: []
    })
    const remove = await run('work_plan', { site: 'babe', work_id: W, start_scenarios_remove: [1] })
    await run('work_save', { plan_id: remove.plan_id })
    expect((s.sent[1].startingScenarios as Obj[]).map((x) => x.initialTitle)).toEqual(['셋째'])
  })
  it('미리보기에서 버전이 다르면 저장하지 않는다', async () => {
    const s = site()
    const raw = (await babeWorks.readRaw(s.read, W)) as { id: string; edit: Obj }
    const next = babeWorks.applyChanges!(raw, { fields: { main: '새 설정' } })
    s.data.version = 9
    await expect(babeWorks.save!(s.write, W, next)).rejects.toThrow('PLAN_STALE')
    expect(s.calls).toEqual(['POST /edit/preview'])
  })

  it('달라진 것이 없다고 하면 저장을 보내지 않는다 (버전을 올리지 않는다)', async () => {
    const s = site()
    const raw = await babeWorks.readRaw(s.read, W)
    await babeWorks.save!(s.write, W, raw)
    expect(s.calls).toEqual(['POST /edit/preview'])
  })

  it('아직 지원하지 않는 바꾸기는 막는다', async () => {
    const s = site()
    const run = tools(s)
    const plan = (args: Obj): Promise<Obj> =>
      run('work_plan', { site: 'babe', work_id: W, ...args })
    await expect(plan({ lorebook_add: [{ title: 'a', keys: '', content: 'c' }] })).rejects.toThrow(
      'BAD_LOREBOOK'
    )
    await expect(plan({ lorebook_remove: [0, 0] })).rejects.toThrow('BAD_INDEX')
    await expect(plan({ lorebook_remove: [3] })).rejects.toThrow('BAD_INDEX')
    await expect(plan({ characters: [{ index: 0, details: 'x' }] })).rejects.toThrow(
      'NO_CHARACTERS'
    )
    await expect(plan({ characters_add: [{ name: 'x' }] })).rejects.toThrow('NO_CHARACTERS')
    await expect(plan({ start_scenarios_remove: [0] })).rejects.toThrow('KEEP_DEFAULT')
    await expect(plan({ start_scenarios_add: [{ title: 'a' }, { title: 'b' }] })).rejects.toThrow(
      'START_LIMIT'
    )
    await expect(plan({ fields: { subtitle: 'x' } })).rejects.toThrow('BAD_FIELD')
    await expect(plan({ lorebook_patch: [{ index: 0, keys: ' , ' }] })).rejects.toThrow(
      'BAD_LOREBOOK'
    )
    await expect(plan({ start_scenarios: [{ index: 2, title: 'x' }] })).rejects.toThrow('BAD_INDEX')
    expect(s.calls).toHaveLength(0)
  })
})

// 저장 때 손대지 않은 칸이 바뀌거나 막히지 않게 하는 고침
describe('베이비챗 작품: 바꾸려던 칸만 바뀐다', () => {
  const lore = (title: string, keys: string, content: string): LoreEntry => ({
    title,
    keys,
    content,
    mode: null,
    offKeys: [],
    turnRange: null,
    offTurnRange: null
  })
  const rawOf = (over: Obj = {}): { id: string; edit: Obj } => ({
    id: W,
    edit: { ...editData(), ...over }
  })
  const apply = (raw: unknown, changes: WorkChanges): { id: string; edit: Obj } =>
    babeWorks.applyChanges!(raw, changes) as { id: string; edit: Obj }
  const books = (raw: { edit: Obj }): Obj[] => raw.edit.keywordBooks as Obj[]
  const two = (): Obj[] => [
    { id: 1, title: '하나', content: '첫 본문', keywords: ['가'], order: 0, extra: 'x1' },
    { id: 2, title: '둘', content: '둘 본문', keywords: ['나'], order: 1, extra: 'x2' }
  ]

  it('전체 교체: 제목이 같은 옛 항목의 번호를 잇고, 짝 없는 새 항목은 번호 없이 만든다', () => {
    const next = apply(rawOf({ keywordBooks: two() }), {
      lorebook: [lore('둘', '나', '둘 새 본문'), lore('셋', '다', '새 항목'), lore('하나', '가', '첫 본문')]
    })
    expect(books(next).map((b) => [b.title, b.id, b.extra])).toEqual([
      ['둘', 2, 'x2'],
      ['셋', undefined, undefined],
      ['하나', 1, 'x1']
    ])
  })

  it('전체 교체: 제자리에서 제목만 고친 항목은 같은 자리 옛 항목을 잇는다', () => {
    const next = apply(rawOf({ keywordBooks: two() }), {
      lorebook: [lore('하나', '가', '첫 본문'), lore('둘 고침', '나', '둘 본문')]
    })
    expect(books(next).map((b) => [b.title, b.id])).toEqual([
      ['하나', 1],
      ['둘 고침', 2]
    ])
  })

  it('쉼표 한 글자가 키워드인 항목은 읽은 글 그대로 보내면 키워드가 그대로다', () => {
    const old = [{ id: 5, title: '쉼표', content: '본문', keywords: ['도현', ',', '"'], order: 0 }]
    const keys = '도현, ,, "'
    const replaced = apply(rawOf({ keywordBooks: old }), { lorebook: [lore('쉼표', keys, '본문')] })
    expect(books(replaced)[0].keywords).toEqual(['도현', ',', '"'])
    const patched = apply(rawOf({ keywordBooks: old }), {
      lorebookPatch: [{ index: 0, keys, content: '바뀐 본문' }]
    })
    expect(books(patched)[0]).toMatchObject({ keywords: ['도현', ',', '"'], content: '바뀐 본문' })
    // 키 글을 바꾸면 쉼표 키워드를 쪼개서는 살릴 수 없으니 멈춘다
    expect(() =>
      apply(rawOf({ keywordBooks: old }), { lorebookPatch: [{ index: 0, keys: '도현, 새' }] })
    ).toThrow('KEY_COMMA')
  })

  it('손대지 않은 옛 항목은 검사하지 않는다: 제목 한 칸만 고쳐도 옛 빈 항목 때문에 막히지 않는다', () => {
    const old = [
      { id: 1, title: '옛 빈 항목', content: '', keywords: [], order: 0 },
      { id: 2, title: '긴 옛 항목', content: '가'.repeat(600), keywords: ['a'], order: 1 }
    ]
    const next = apply(rawOf({ keywordBooks: old }), { fields: { title: '새 이름' } })
    expect(books(next)).toEqual(old)
    // 같은 항목의 다른 칸만 고쳐도 건드리지 않은 칸은 보지 않는다
    expect(() =>
      apply(rawOf({ keywordBooks: old }), { lorebookPatch: [{ index: 0, title: '제목만' }] })
    ).not.toThrow()
    // 고친 칸은 본다
    expect(() =>
      apply(rawOf({ keywordBooks: old }), { lorebookPatch: [{ index: 0, content: ' ' }] })
    ).toThrow('BAD_LOREBOOK')
    expect(() =>
      apply(rawOf({ keywordBooks: old }), { lorebookPatch: [{ index: 1, content: '나'.repeat(501) }] })
    ).toThrow('BAD_LENGTH lorebook[1].content')
    expect(() =>
      apply(rawOf({ keywordBooks: old }), { lorebookPatch: [{ index: 1, content: '나'.repeat(500) }] })
    ).not.toThrow()
  })

  it('전체 교체에서도 옛 항목과 같은 칸은 검사하지 않고 바뀐 칸만 본다', () => {
    const old = [{ id: 2, title: '긴 옛 항목', content: '가'.repeat(600), keywords: ['a'], order: 0 }]
    expect(() =>
      apply(rawOf({ keywordBooks: old }), {
        lorebook: [lore('긴 옛 항목', 'a', '가'.repeat(600)), lore('새 항목', 'b', '본문')]
      })
    ).not.toThrow()
    expect(() =>
      apply(rawOf({ keywordBooks: old }), { lorebook: [lore('새 항목', 'b', '가'.repeat(501))] })
    ).toThrow('BAD_LENGTH')
  })

  it('고칠 때도 바뀐 칸은 길이를 본다 (이름 20, 소개 500, 시작 설정, 로어북)', () => {
    const raw = rawOf()
    const fail = (changes: WorkChanges, where: string): void =>
      expect(() => apply(raw, changes)).toThrow('BAD_LENGTH ' + where)
    fail({ fields: { title: '가'.repeat(21) } }, 'title')
    fail({ fields: { description: '가'.repeat(501) } }, 'description')
    fail({ startScenarios: [{ index: 0, title: '가'.repeat(16) }] }, 'start_scenarios[0].title')
    fail({ startScenarios: [{ index: 1, content: '가'.repeat(1001) }] }, 'start_scenarios[1].content')
    fail({ startScenarios: [{ index: 1, dialogue: '가'.repeat(501) }] }, 'start_scenarios[1].dialogue')
    fail({ startScenarios: [{ index: 0, description: '가'.repeat(501) }] }, 'start_scenarios[0].description')
    fail({ startScenarios: [{ index: 0, dialogue: ' ' }] }, 'start_scenarios[0].dialogue')
    fail({ lorebookAdd: [lore('가'.repeat(21), 'a', '본문')] }, 'lorebook[1].title')
    fail({ lorebookAdd: [lore('제목', 'a, b, c, d, e, f', '본문')] }, 'lorebook[1].keys')
    // 한도 안이면 통과한다
    expect(() =>
      apply(raw, {
        fields: { title: '가'.repeat(20), description: '가'.repeat(500) },
        startScenarios: [{ index: 0, title: '가'.repeat(15), content: '가'.repeat(1000) }],
        lorebookAdd: [lore('가'.repeat(20), 'a, b, c, d, e', '가'.repeat(500))]
      })
    ).not.toThrow()
    // 캐릭터 설정은 문서(7,000)와 코드(5,000~7,000) 한도가 달라 고칠 때는 검사하지 않는다
    expect(() => apply(raw, { fields: { main: '가'.repeat(9000) } })).not.toThrow()
  })

  it('새 시작 설정은 이름·상황·첫 대사를 채워야 하고 빈 칸을 기본값으로 채워 보내지 않는다', () => {
    const raw = rawOf({ startingScenarios: [] })
    const add = (draft: Obj): { id: string; edit: Obj } =>
      apply(raw, { startScenariosAdd: [draft] })
    expect(() => add({ title: '셋째', content: '상황' })).toThrow('BAD_LENGTH start_scenarios_add[0].dialogue')
    expect(() => add({ content: '상황', dialogue: '대사' })).toThrow('BAD_LENGTH start_scenarios_add[0].title')
    expect(() => add({ title: '가'.repeat(16), content: '상황', dialogue: '대사' })).toThrow('BAD_LENGTH')
    expect((add({ title: '셋째', content: '상황', dialogue: '대사' }).edit.startingScenarios as Obj[])[0]).toEqual({
      initialTitle: '셋째',
      initialAction: '상황',
      initialMessage: '대사',
      playGuide: '',
      replySuggestions: []
    })
  })

  it('추가 시작 설정 목록이 없던 작품의 기본 시작 설정을 고쳐도 빈 목록을 만들지 않는다', () => {
    const raw = rawOf()
    delete raw.edit.startingScenarios
    const next = apply(raw, { startScenarios: [{ index: 0, content: '새 상황' }] })
    expect(next.edit.initialAction).toBe('새 상황')
    expect('startingScenarios' in next.edit).toBe(false)
    expect(babeSaveBody(next.edit).startingScenarios).toBeUndefined()
  })

  it('저장 본문: 값이 없는(없거나 null) 칸은 예전 모양이다: 글 칸은 빈 글, 목록 칸은 칸을 뺀다', () => {
    const e = editData()
    e.description = null
    e.recommendedModel = null
    e.replySuggestions = null
    e.keywordBooks = null
    e.startingScenarios = null
    delete e.name
    const body = babeSaveBody(e)
    expect(body.name).toBe('')
    expect(body.description).toBe('')
    expect(body.recommendedModel).toBe('')
    // 요청 본문(JSON)에서는 칸 자체가 없다. null을 보내지 않는다
    const sent = JSON.parse(JSON.stringify(body)) as Obj
    for (const key of ['replySuggestions', 'keywordBooks', 'startingScenarios'])
      expect(key in sent).toBe(false)
    delete e.keywordBooks
    delete e.startingScenarios
    expect(babeSaveBody(e).keywordBooks).toBeUndefined()
    expect(babeSaveBody(e).startingScenarios).toBeUndefined()
  })

  it('저장 본문: 값이 있는 칸은 원본 그대로 보낸다 (빈 글도 그대로)', () => {
    const e = editData()
    e.description = ''
    e.recommendedModel = ''
    const body = babeSaveBody(e)
    expect(body).toMatchObject({ name: '시험 작품', description: '', recommendedModel: '' })
    expect(body.keywordBooks).toHaveLength(1)
    expect(body.replySuggestions).toEqual(['안녕'])
    // 목록이 아닌 값(옛 모양이 아닌 것)은 지우지 않고 그대로 둔다
    e.keywordBooks = 'x'
    expect(babeSaveBody(e).keywordBooks).toBe('x')
  })

  it('옛 값이 한도를 넘는 작품: 같은 값을 다시 담거나 다른 칸만 고쳐도 막히지 않는다', () => {
    const raw = rawOf({
      name: '가'.repeat(21),
      description: '나'.repeat(501),
      initialTitle: '다'.repeat(16),
      initialAction: '라'.repeat(1001),
      initialMessage: '마'.repeat(501),
      playGuide: '바'.repeat(501),
      startingScenarios: [
        {
          id: 9,
          initialTitle: '사'.repeat(16),
          initialAction: '둘째 상황',
          initialMessage: '둘째 대사',
          playGuide: '',
          replySuggestions: []
        }
      ]
    })
    const e = raw.edit
    expect(() =>
      apply(raw, {
        // 제목·소개는 읽은 값 그대로, 다른 칸(캐릭터 설정)만 바꾼다
        fields: { title: e.name as string, description: e.description as string, main: '새 설정' },
        startScenarios: [
          { index: 0, title: e.initialTitle as string, content: e.initialAction as string },
          { index: 0, dialogue: e.initialMessage as string, description: e.playGuide as string },
          { index: 1, title: '사'.repeat(16), content: '새 둘째 상황' }
        ]
      })
    ).not.toThrow()
    // 값을 바꾸면 한도를 본다
    expect(() => apply(raw, { fields: { title: '가'.repeat(22) } })).toThrow('BAD_LENGTH title')
    expect(() => apply(raw, { startScenarios: [{ index: 1, title: '사'.repeat(17) }] })).toThrow(
      'BAD_LENGTH start_scenarios[1].title'
    )
  })
})

// 기능 표·숨은 설정·못 읽는 칸 안내 (읽기와 안내만 넓힌다)
describe('베이비챗 작품: 기능 표와 숨은 설정', () => {
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
  const rawOf = (over: Obj = {}): { id: string; edit: Obj } => ({
    id: W,
    edit: { ...editData(), ...over }
  })

  it('기능 표: 열쇠 22개가 모두 있고 note는 40자 이내다', () => {
    const features = babeWorks.features!
    expect(Object.keys(features).sort()).toEqual([...KEYS].sort())
    for (const f of Object.values(features)) expect((f.note ?? '').length).toBeLessThanOrEqual(40)
    // 오늘 코드와 맞춘 값: 태그는 읽을 수 있고, 감정 이미지는 이름·순서를 못 고친다
    expect(features.tags).toMatchObject({ read: 'yes', write: 'partial' })
    expect(features.situation_images.write).toBe('partial')
    expect(features.characters).toMatchObject({ site: 'no', read: 'no', write: 'no' })
  })

  it('extras: 짧은 설정은 그대로, 개수·유무만 싣고 본문은 싣지 않는다', () => {
    const body = babeWorks.normalize(rawOf())
    expect(body.extras).toEqual({
      version: 3,
      hashtags: ['순애'],
      category: 11,
      is_adult: true,
      target_gender: 'male',
      system_prompt: 'custom',
      recommended_model: 'gemini',
      recommended_config_mode: 'bulk',
      babechat_only: false,
      tookit_only: false,
      creator_keyword_book_limit: 5,
      // 캐릭터 프로필 글은 작품 본문이라 개수·글자 수만 싣는다
      profile_jobs_count: 1,
      profile_interests_count: 0,
      profile_likes_count: 1,
      profile_dislikes_count: 0,
      profile_date_length: 10,
      profile_location_length: 2,
      profile_height_length: 3,
      profile_weight_length: 2,
      profile_details_length: 2,
      has_cover: true,
      emotion_image_count: 1,
      hidden_emotion_image_count: 0,
      model_config_count: 2,
      reply_suggestion_counts: [2, 2]
    })
    // 캐릭터 설정·소개·시작 설정 글은 extras에 없다
    const dumped = JSON.stringify(body.extras)
    for (const secret of [
      '캐릭터 설정',
      '첫 상황',
      '첫 대사',
      'img.example',
      '안녕',
      '학생',
      '책',
      '2000-01-01',
      '서울',
      '상세'
    ])
      expect(dumped).not.toContain(secret)
  })

  it('extras: 프로필 글은 길이와 상관없이 글자 수·개수만, 원본에 없는 칸은 만들지 않는다', () => {
    const raw = rawOf({
      details: '가'.repeat(81),
      jobs: Array.from({ length: 21 }, (_, i) => '직업' + i),
      likes: ['나'.repeat(81)],
      height: '가'.repeat(80),
      babeChatOnlyEndAt: '2030-01-01T00:00:00Z',
      images: [{ url: '', hidden: false }, { url: 'https://img.example/a.webp', hidden: true }]
    })
    delete raw.edit.targetGender
    delete raw.edit.modelConfigs
    delete raw.edit.replySuggestions
    delete raw.edit.startingScenarios
    const extras = babeWorks.normalize(raw).extras!
    expect(extras).toMatchObject({
      profile_details_length: 81,
      profile_jobs_count: 21,
      profile_likes_count: 1,
      profile_height_length: 80,
      babechat_only_end_at: '2030-01-01T00:00:00Z',
      has_cover: false,
      emotion_image_count: 1,
      hidden_emotion_image_count: 1
    })
    expect('profile_details' in extras || 'profile_jobs' in extras).toBe(false)
    expect('target_gender' in extras).toBe(false)
    expect('model_config_count' in extras).toBe(false)
    expect('reply_suggestion_counts' in extras).toBe(false)
    expect('tookit_only_end_at' in extras).toBe(false)
  })

  it('읽을 때마다 변하는 칸(조회·대화·좋아요 수, 시각)은 extras와 저장 본문에 영향을 주지 않는다', () => {
    const volatile = { viewCount: 1, chatCount: 2, likeCount: 3, updatedAt: 'x', createdAt: 'y' }
    const a = rawOf()
    const b = rawOf(volatile)
    // 읽을 때마다 달라지는 값이 든 원본과 아닌 원본이 같은 값으로 읽히고 같은 저장 본문이 된다
    expect(JSON.stringify(babeWorks.normalize(b))).toBe(JSON.stringify(babeWorks.normalize(a)))
    expect(JSON.stringify(babeSaveBody(b.edit))).toBe(JSON.stringify(babeSaveBody(a.edit)))
    const dumped = JSON.stringify(babeWorks.normalize(b).extras)
    for (const key of ['view', 'chat_count', 'like_count', 'updated', 'created'])
      expect(dumped).not.toContain(key)
  })

  it('extras와 unsupported: 읽을 때마다 같은 값이고 밖에서 바꿔도 안 변한다', () => {
    const raw = rawOf()
    const a = babeWorks.normalize(raw)
    const b = babeWorks.normalize(structuredClone(raw))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.unsupported).toEqual([
      '추천 답변 내용',
      '모델별 설정 값',
      '카테고리 이름',
      '수정 시각',
      '댓글·통계'
    ])
    a.unsupported!.push('x')
    expect(babeWorks.normalize(raw).unsupported).toHaveLength(5)
    expect(a).toMatchObject({
      title: '시험 작품',
      updatedAt: 'v3',
      status: null,
      characters: []
    })
    expect(Object.keys(a.fields)).toEqual(['title', 'description', 'main'])
  })

  it('work_read 결과에 숨은 설정과 못 읽는 칸이 보인다', async () => {
    const s = site()
    const out = await tools(s)('work_read', { site: 'babe', work_id: W })
    expect(out.extras).toMatchObject({ category: 11, is_adult: true, has_cover: true })
    expect(out.unsupported).toContain('댓글·통계')
  })

  it('전체 교체: given이 있어도 이 플랫폼에 없는 칸(mode 등)은 저장 본문에 얹지 않는다', () => {
    const lore = (given?: string[]): LoreEntry => ({
      title: '로어북 1',
      keys: '학교, 교실',
      content: '로어 본문',
      mode: 'always',
      offKeys: ['x'],
      turnRange: 3,
      offTurnRange: 4,
      ...(given ? { given } : {})
    })
    const next = (given?: string[]): Obj[] =>
      (babeWorks.applyChanges!(rawOf(), { lorebook: [lore(given)] }) as { edit: Obj }).edit
        .keywordBooks as Obj[]
    const plain = next()
    expect(next(['mode', 'offKeys', 'turnRange', 'offTurnRange'])).toEqual(plain)
    expect(next([])).toEqual(plain)
    expect(plain[0]).toEqual({
      id: 7,
      title: '로어북 1',
      content: '로어 본문',
      keywords: ['학교', '교실'],
      order: 4
    })
  })

  it('save: 미리보기가 달라진 것 없음이면 보내지 않고 skipped를 돌려준다', async () => {
    const s = site()
    const raw = await babeWorks.readRaw(s.read, W)
    expect(await babeWorks.save!(s.write, W, raw)).toEqual({ skipped: true })
    expect(s.calls).toEqual(['POST /edit/preview'])

    // 달라진 것이 있으면 저장을 보내고 skipped가 아니다
    const next = babeWorks.applyChanges!(raw, { fields: { main: '바뀐 설정' } })
    expect(await babeWorks.save!(s.write, W, next)).toBeUndefined()
    expect(s.calls).toEqual(['POST /edit/preview', 'POST /edit/preview', 'PUT /edit'])
  })
})
