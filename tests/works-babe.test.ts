import { describe, expect, it } from 'vitest'
import { babeSaveBody, babeWorks } from '../src/main/works/babe'
import { workAdapter, workReadAllowed, workWriteAllowed } from '../src/main/works/adapters'
import { createWorkTools } from '../src/main/works/tools'
import type { WorkFetch, WorkWrite } from '../src/main/works/types'

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
  it('허용 주소: 읽기 둘, 쓰기는 미리보기(POST)와 저장(PUT)뿐이다', () => {
    expect(workReadAllowed('babe', API + 'my')).toBe(true)
    expect(workReadAllowed('babe', API + W + '/edit')).toBe(true)
    expect(workReadAllowed('babe', API + W)).toBe(false)
    expect(workReadAllowed('babe', API + 'my?tab=all')).toBe(false)
    expect(workReadAllowed('babe', 'https://babechat.ai/ko/api/characters/my')).toBe(false)
    expect(workWriteAllowed('babe', 'PUT', API + W + '/edit')).toBe(true)
    expect(workWriteAllowed('babe', 'POST', API + W + '/edit/preview')).toBe(true)
    expect(workWriteAllowed('babe', 'POST', API + W + '/edit')).toBe(false)
    expect(workWriteAllowed('babe', 'PUT', API + W + '/edit/preview')).toBe(false)
    expect(workWriteAllowed('babe', 'DELETE', API + W)).toBe(false)
    expect(workWriteAllowed('babe', 'PUT', API + 'edit/draft')).toBe(false)
    expect(workWriteAllowed('babe', 'POST', API + 'create')).toBe(false)
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
    await expect(plan({ lorebook: [{ title: 'a', keys: 'k', content: 'c' }] })).rejects.toThrow(
      'NO_LOREBOOK_REPLACE'
    )
    await expect(plan({ characters: [{ index: 0, details: 'x' }] })).rejects.toThrow('BAD_CHANGES')
    await expect(plan({ fields: { subtitle: 'x' } })).rejects.toThrow('BAD_FIELD')
    await expect(plan({ lorebook_patch: [{ index: 0, keys: ' , ' }] })).rejects.toThrow(
      'BAD_LOREBOOK'
    )
    await expect(plan({ start_scenarios: [{ index: 2, title: 'x' }] })).rejects.toThrow('BAD_INDEX')
    expect(s.calls).toHaveLength(0)
  })
})
