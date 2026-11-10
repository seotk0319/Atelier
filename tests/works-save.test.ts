import { describe, expect, it } from 'vitest'
import { edenSaveBody, edenWorks } from '../src/main/works/eden'
import { workWriteAllowed } from '../src/main/works/adapters'
import { createWorkTools, toolMessage } from '../src/main/works/tools'
import { diffBodies } from '../src/main/works/save-tools'
import type { WorkFetch, WorkWrite } from '../src/main/works/types'

const W = '11111111-2222-4333-8444-555555555555'
const C1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1'
const C2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2'
const O = 'https://www.eden-chat.com'
type Obj = Record<string, unknown>

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

/** 에덴 흉내: 읽기 주소에 답하고, PUT을 받으면 그 본문대로 내용을 바꾼다 */
function site(): {
  read: WorkFetch
  write: WorkWrite
  puts: Obj[]
  work: Obj
  characters: Obj[]
  failNext: { status: number } | null
} {
  const state = {
    puts: [] as Obj[],
    failNext: null as { status: number } | null,
    work: {
      id: W,
      title: '시험 작품',
      subtitle: '부제',
      description: '소개',
      scenario_settings: '메인 프롬프트',
      creator_comment: null,
      work_type: 'original',
      genre: [],
      tags: ['학원'],
      categories: ['romance'],
      hashtags: [],
      template_type: 'default',
      prompt_version: 'v2',
      image_source_mode: 'mixed',
      cover_image_url: 'https://img.example/cover.webp',
      visibility: 'public',
      status: 'active',
      is_nsfw: true,
      selected_scenario_id: 1,
      selected_preset_id: null,
      character_presets: [],
      recommended_personas: [],
      updated_at: '2026-11-10T00:00:00.000Z',
      lorebook: [
        {
          key: '학교',
          title: '일상',
          value: '로어 하나',
          triggerMode: 'keyword',
          offKeywords: [],
          turnRange: 5,
          offTurnRange: 5
        },
        {
          key: '',
          title: '늘 켜짐',
          value: '로어 둘',
          triggerMode: 'always',
          offKeywords: [],
          turnRange: 5,
          offTurnRange: 5
        }
      ],
      start_scenarios: [
        { id: 1, title: '기본', isDefault: true, detailedSettings: '시작 본문', subPrompt: '' }
      ]
    } as Obj,
    characters: [
      {
        id: C1,
        character_name: '첫째',
        character_order: 0,
        is_main_character: true,
        character_details: '첫째 설정',
        character_info: '',
        start_scenario: null
      },
      {
        id: C2,
        character_name: '둘째',
        character_order: 1,
        is_main_character: false,
        character_details: '둘째 설정',
        character_info: '',
        start_scenario: null
      }
    ] as Obj[]
  }
  const read: WorkFetch = async (url) => {
    if (!edenWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE')
    if (url === O + '/api/works/' + W) return ok(state.work)
    if (url === O + '/api/works/' + W + '/characters') return ok(state.characters)
    if (url.endsWith('/' + C1 + '/images'))
      return ok([
        { id: 'img-1', url: 'https://img.example/1.webp' },
        { id: 'img-2', url: '' }
      ])
    if (url.endsWith('/images')) return ok([])
    return new Response('no', { status: 404 })
  }
  const write: WorkWrite = async (method, url, body) => {
    if (!edenWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE')
    if (state.failNext) {
      const { status } = state.failNext
      state.failNext = null
      return new Response('{"error":"nope"}', { status })
    }
    const sent = body as Obj
    state.puts.push(sent)
    const { characters, ...rest } = sent
    state.work = {
      ...state.work,
      ...rest,
      updated_at: '2026-11-10T00:00:0' + state.puts.length + '.000Z'
    }
    state.characters = (characters as Obj[]).map((c) => ({
      ...state.characters.find((old) => old.id === c.id),
      ...c,
      images: undefined
    }))
    return ok({ success: true, workId: W })
  }
  return Object.assign(state, { read, write })
}

function tools(
  s: ReturnType<typeof site>,
  files: Record<string, string> = {}
): {
  run: (name: string, args?: Obj) => Promise<Obj>
  snaps: string[]
} {
  const snaps: string[] = []
  const all = createWorkTools({
    reader: () => s.read,
    writer: () => s.write,
    snapshot: async (platform, name) => {
      snaps.push(platform + '/' + name)
      return 'C:/snap/' + snaps.length + '.json'
    },
    readFile: async (path) => {
      if (!(path in files)) throw new Error('ENOENT')
      return files[path]
    }
  })
  return {
    snaps,
    run: (name, args = {}) => all.find((t) => t.name === name)!.run(args) as Promise<Obj>
  }
}

describe('에덴 저장 본문', () => {
  it('허용 요청: 작품 통째 저장·삭제와 새 작품 임시저장뿐이다', () => {
    expect(workWriteAllowed('eden', 'PUT', O + '/api/works/' + W)).toBe(true)
    expect(workWriteAllowed('eden', 'DELETE', O + '/api/works/' + W)).toBe(true)
    expect(workWriteAllowed('eden', 'PATCH', O + '/api/works/' + W)).toBe(false)
    expect(workWriteAllowed('eden', 'PUT', O + '/api/works/' + W + '/characters')).toBe(false)
    expect(workWriteAllowed('eden', 'PUT', O + '/api/works/new')).toBe(true)
    expect(workWriteAllowed('eden', 'PUT', O + '/api/works/' + W + '?x=1')).toBe(false)
    expect(workWriteAllowed('eden', 'PUT', 'https://evil.example/api/works/' + W)).toBe(false)
    expect(workWriteAllowed('babe', 'PUT', O + '/api/works/' + W)).toBe(false)
  })

  it('읽은 값을 편집기와 같은 모양으로 옮기고 공개 상태를 그대로 보낸다', async () => {
    const s = site()
    const body = edenSaveBody(await edenWorks.readRaw(s.read, W))
    expect(body).toMatchObject({
      title: '시험 작품',
      scenario_settings: '메인 프롬프트',
      visibility: 'public',
      status: 'active',
      is_nsfw: true,
      categories: ['romance'],
      tags: ['학원'],
      prompt_version: 'v2',
      creator_comment: null,
      selected_scenario_id: 1,
      cover_image_url: 'https://img.example/cover.webp'
    })
    expect((body.lorebook as Obj[]).length).toBe(2)
    const chars = body.characters as Obj[]
    expect(chars.map((c) => [c.id, c.character_order, c.is_main_character])).toEqual([
      [C1, 0, true],
      [C2, 1, false]
    ])
    // 이미지 목록을 같이 보낸다. 주소가 http가 아니면 번호만 보낸다
    expect(chars[0].images).toEqual([
      { id: 'img-1', url: 'https://img.example/1.webp' },
      { id: 'img-2' }
    ])
    expect(chars[1].images).toEqual([])
    // 읽기 응답에 없는 값은 지어내지 않는다
    expect('bgm' in body).toBe(false)
    expect('delete_missing' in body).toBe(false)
  })

  it('공개 상태를 읽지 못한 원본으로는 저장 본문을 만들지 않는다', () => {
    expect(() =>
      edenSaveBody({ work: { scenario_settings: 'x', status: 'active' }, characters: [] })
    ).toThrow('WORK_SHAPE')
  })
})

describe('작품 계획·저장', () => {
  it('work_plan은 쓰지 않고 달라질 곳만 알려 준다', async () => {
    const s = site()
    const t = tools(s)
    const plan = await t.run('work_plan', {
      site: '에덴',
      work_id: W,
      fields: { main: '메인 프롬프트 수정' },
      lorebook_patch: [{ index: 0, title: '일상 2' }],
      characters: [{ index: 1, details: '둘째 새 설정' }]
    })
    expect(s.puts).toHaveLength(0)
    expect(plan.plan_id).toMatch(/^[0-9a-f]{8}$/)
    expect((plan.changes as { where: string }[]).map((c) => c.where)).toEqual([
      'main',
      'lorebook[0] 일상 2 · title',
      'characters[1] 둘째 · details'
    ])
    expect((plan.changes as { preview: Obj }[])[0].preview).toEqual({
      before: '메인 프롬프트',
      after: '메인 프롬프트 수정'
    })
  })

  it('work_save: 바꾼 칸만 달라지고 공개 상태·나머지는 그대로다', async () => {
    const s = site()
    const t = tools(s)
    const plan = await t.run('work_plan', {
      site: 'eden',
      work_id: W,
      fields: { main: '새 메인', creator_comment: '' },
      start_scenarios: [{ index: 0, content: '새 시작', sub_prompt: '보조' }]
    })
    const saved = await t.run('work_save', { plan_id: plan.plan_id })
    expect(saved).toMatchObject({
      saved: true,
      verified: true,
      mismatches: [],
      visibility: 'public',
      status: 'active'
    })
    expect(saved.backup).toBe('C:/snap/1.json')
    expect(t.snaps).toHaveLength(2) // 저장 전 백업 + 저장 뒤 확인본
    expect(s.puts).toHaveLength(1)
    expect(s.puts[0]).toMatchObject({
      scenario_settings: '새 메인',
      description: '소개',
      visibility: 'public',
      status: 'active',
      creator_comment: null
    })
    expect((s.puts[0].start_scenarios as Obj[])[0]).toMatchObject({
      id: 1,
      title: '기본',
      isDefault: true,
      detailedSettings: '새 시작',
      subPrompt: '보조'
    })
    expect((s.puts[0].lorebook as Obj[]).map((e) => e.title)).toEqual(['일상', '늘 켜짐'])
    // 같은 계획으로 두 번 저장할 수 없다
    await expect(t.run('work_save', { plan_id: plan.plan_id })).rejects.toThrow('PLAN_NOT_FOUND')
  })

  it('계획 뒤 플랫폼 내용이 바뀌었으면 저장하지 않는다', async () => {
    const s = site()
    const t = tools(s)
    const plan = await t.run('work_plan', { site: 'eden', work_id: W, fields: { main: '새 메인' } })
    s.work.description = '그 사이 편집화면에서 고친 소개'
    await expect(t.run('work_save', { plan_id: plan.plan_id })).rejects.toThrow('PLAN_STALE')
    expect(s.puts).toHaveLength(0)
    expect(toolMessage(new Error('PLAN_STALE'))).toContain('다시')
  })

  it('달라질 것이 없으면 계획을 만들지 않는다', async () => {
    const s = site()
    const plan = await tools(s).run('work_plan', {
      site: 'eden',
      work_id: W,
      fields: { main: '메인 프롬프트' }
    })
    expect(plan).toMatchObject({ changes: [], nothing_to_save: true })
    expect(plan.plan_id).toBeUndefined()
  })

  it('파일에서 읽기: BOM과 윈도우 줄바꿈을 걷어낸다', async () => {
    const s = site()
    const t = tools(s, {
      'D:/work/main.md': '\uFEFF첫 줄\r\n둘째 줄',
      'D:/work/lore.json': JSON.stringify([
        { title: '새 로어', keys: '바다', content: '본문', off_keys: ['밤'], turn_range: 3 }
      ])
    })
    const plan = await t.run('work_plan', {
      site: 'eden',
      work_id: W,
      field_files: { main: 'D:/work/main.md' },
      lorebook_file: 'D:/work/lore.json'
    })
    await t.run('work_save', { plan_id: plan.plan_id })
    expect(s.puts[0].scenario_settings).toBe('첫 줄\n둘째 줄')
    expect(s.puts[0].lorebook).toEqual([
      {
        title: '새 로어',
        key: '바다',
        value: '본문',
        triggerMode: 'keyword',
        offKeywords: ['밤'],
        turnRange: 3,
        offTurnRange: 5
      }
    ])
    await expect(
      t.run('work_plan', { site: 'eden', work_id: W, field_files: { main: 'D:/work/none.md' } })
    ).rejects.toThrow('BAD_FILE')
    await expect(
      t.run('work_plan', { site: 'eden', work_id: W, field_files: { main: 'D:/work/a.exe' } })
    ).rejects.toThrow('BAD_FILE')
  })

  it('잘못된 요청은 플랫폼에 닿기 전에 막는다', async () => {
    const s = site()
    const t = tools(s)
    const plan = (args: Obj): Promise<Obj> =>
      t.run('work_plan', { site: 'eden', work_id: W, ...args })
    await expect(plan({})).rejects.toThrow('NO_CHANGES')
    await expect(plan({ fields: { main: '   ' } })).rejects.toThrow('EMPTY_FIELD')
    await expect(plan({ fields: { nope: 'x' } })).rejects.toThrow('BAD_FIELD')
    await expect(plan({ characters: [{ index: 9, details: 'x' }] })).rejects.toThrow('BAD_INDEX')
    await expect(plan({ lorebook_patch: [{ index: 0, content: '' }] })).rejects.toThrow(
      'BAD_LOREBOOK'
    )
    await expect(plan({ lorebook_patch: [{ index: 0, keys: '' }] })).rejects.toThrow('BAD_LOREBOOK')
    await expect(
      plan({ lorebook: [{ title: 'a', content: 'b', keys: 'k' }], lorebook_patch: [{ index: 0 }] })
    ).rejects.toThrow('BAD_CHANGES')
    expect(s.puts).toHaveLength(0)
  })

  it('플랫폼이 저장을 거절하면 SAVE_FAILED, 로그인이 풀렸으면 LOGIN_REQUIRED', async () => {
    const s = site()
    const t = tools(s)
    const a = await t.run('work_plan', { site: 'eden', work_id: W, fields: { main: 'A' } })
    s.failNext = { status: 400 }
    await expect(t.run('work_save', { plan_id: a.plan_id })).rejects.toThrow('SAVE_FAILED 400')
    const b = await t.run('work_plan', { site: 'eden', work_id: W, fields: { main: 'B' } })
    s.failNext = { status: 401 }
    await expect(t.run('work_save', { plan_id: b.plan_id })).rejects.toThrow('LOGIN_REQUIRED')
    expect(s.puts).toHaveLength(0)
  })

  it('저장 뒤 다시 읽은 값이 다르면 verified가 false다', async () => {
    const s = site()
    const t = tools(s)
    const plan = await t.run('work_plan', { site: 'eden', work_id: W, fields: { main: '새 메인' } })
    const original = s.write
    s.write = async (method, url, body) => {
      const res = await original(method, url, body)
      s.work.scenario_settings = '플랫폼이 다르게 저장함'
      return res
    }
    const strict = tools(Object.assign(s, {}))
    void strict
    const saved = await createWorkTools({
      reader: () => s.read,
      writer: () => s.write,
      snapshot: async () => 'x',
      readFile: async () => ''
    })
      .find((x) => x.name === 'work_save')!
      .run({ plan_id: plan.plan_id })
      .catch((e: Error) => e.message)
    // 계획은 그 도구 묶음 안에만 있으므로 다른 묶음에서는 찾지 못한다
    expect(saved).toBe('PLAN_NOT_FOUND')
    const done = await t.run('work_save', { plan_id: plan.plan_id })
    expect(done).toMatchObject({ saved: true, verified: false })
    expect((done.mismatches as { where: string }[])[0].where).toBe('main')
  })

  it('로어북 추가·삭제: 고치기 → 지우기 → 더하기 순서로 얹는다', async () => {
    const s = site()
    const t = tools(s)
    const plan = await t.run('work_plan', {
      site: 'eden',
      work_id: W,
      lorebook_patch: [{ index: 1, title: '늘 켜짐 2' }],
      lorebook_remove: [0],
      lorebook_add: [{ title: '새 로어', keys: '바다', content: '새 본문', mode: 'keyword' }]
    })
    const saved = await t.run('work_save', { plan_id: plan.plan_id })
    expect(saved).toMatchObject({ saved: true, verified: true })
    expect(s.puts[0].lorebook).toEqual([
      {
        key: '',
        title: '늘 켜짐 2',
        value: '로어 둘',
        triggerMode: 'always',
        offKeywords: [],
        turnRange: 5,
        offTurnRange: 5
      },
      {
        title: '새 로어',
        key: '바다',
        value: '새 본문',
        triggerMode: 'keyword',
        offKeywords: [],
        turnRange: 5,
        offTurnRange: 5
      }
    ])
    await expect(
      t.run('work_plan', {
        site: 'eden',
        work_id: W,
        lorebook: [{ title: 'a', keys: 'k', content: 'c' }],
        lorebook_add: [{ title: 'b', keys: 'k', content: 'c' }]
      })
    ).rejects.toThrow('BAD_CHANGES')
  })

  it('시작 상황·캐릭터 추가와 삭제', async () => {
    const s = site()
    const t = tools(s)
    const add = await t.run('work_plan', {
      site: 'eden',
      work_id: W,
      start_scenarios_add: [{ title: '둘째 모드', content: '둘째 본문', sub_prompt: '보조' }],
      characters_add: [{ name: '셋째', details: '셋째 설정' }]
    })
    expect((add.changes as { where: string; kind: string }[]).map((c) => c.kind)).toEqual([
      'added',
      'added'
    ])
    expect(await t.run('work_save', { plan_id: add.plan_id })).toMatchObject({ verified: true })
    const starts = s.puts[0].start_scenarios as Obj[]
    expect(starts).toHaveLength(2)
    expect(starts[1]).toMatchObject({
      title: '둘째 모드',
      detailedSettings: '둘째 본문',
      subPrompt: '보조',
      isDefault: false,
      imageCodes: [],
      elementOrder: ['image', 'situation', 'dialogue']
    })
    expect(Number.isInteger(starts[1].id) && starts[1].id !== 1).toBe(true)
    const chars = s.puts[0].characters as Obj[]
    expect(chars).toHaveLength(3)
    expect(chars[2]).toMatchObject({
      character_name: '셋째',
      character_details: '셋째 설정',
      is_main_character: false,
      character_order: 2,
      images: []
    })
    expect(String(chars[2].id)).toMatch(/^[0-9a-f-]{36}$/)
    expect('delete_missing' in s.puts[0]).toBe(false)

    const remove = await t.run('work_plan', {
      site: 'eden',
      work_id: W,
      start_scenarios_remove: [1],
      characters_remove: [2]
    })
    expect(await t.run('work_save', { plan_id: remove.plan_id })).toMatchObject({ verified: true })
    expect(s.puts[1].delete_missing).toBe(true)
    expect((s.puts[1].characters as Obj[]).map((c) => c.character_name)).toEqual(['첫째', '둘째'])
    expect(s.puts[1].start_scenarios).toHaveLength(1)

    const plan = (args: Obj): Promise<Obj> =>
      t.run('work_plan', { site: 'eden', work_id: W, ...args })
    await expect(plan({ start_scenarios_remove: [0] })).rejects.toThrow('KEEP_DEFAULT')
    await expect(plan({ characters_remove: [0] })).rejects.toThrow('KEEP_DEFAULT')
    await expect(plan({ characters_add: [{ name: ' ' }] })).rejects.toThrow('EMPTY_FIELD')
    await expect(plan({ characters_remove: [5] })).rejects.toThrow('BAD_INDEX')
  })
  it('diffBodies: 로어북 추가·삭제를 알린다', async () => {
    const s = site()
    const before = edenWorks.normalize(await edenWorks.readRaw(s.read, W))
    const after = { ...before, lorebook: before.lorebook.slice(0, 1) }
    expect(diffBodies(before, after)).toEqual([
      { where: 'lorebook[1] 늘 켜짐', kind: 'removed', before_length: 4 }
    ])
    expect(diffBodies(after, before)[0]).toMatchObject({ kind: 'added' })
  })
})
