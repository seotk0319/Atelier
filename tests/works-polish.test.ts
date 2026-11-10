// 작품 MCP 다듬기: 큰 결과 나눠 주기, 플랫폼 안내(guide), 시작 상황·캐릭터 파일 입력, 제목이 빈 작품 삭제.
// 공용 도구 동작만 보므로 등록부에 시험용 연결부를 잠깐 넣어 쓴다(플랫폼 요청은 하지 않는다).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WORK_ADAPTERS } from '../src/main/works/adapters'
import { createWorkTools, toolMessage } from '../src/main/works/tools'
import type {
  ImageGroup,
  WorkAdapter,
  WorkBody,
  WorkChanges,
  WorkImage
} from '../src/main/works/types'

type Obj = Record<string, unknown>
const ID = 'w-001'

interface Raw {
  body: WorkBody
  groups: ImageGroup[]
}

const img = (i: number, isDefault = false): WorkImage => ({
  id: 'img-' + i,
  url: 'https://cdn.example/assets/' + 'x'.repeat(120) + '/' + i + '.webp',
  label: 'folder/name' + i,
  description: '설명 ' + i,
  visibility: 'public',
  isDefault
})

function body(over: Partial<WorkBody> = {}): WorkBody {
  return {
    id: ID,
    title: '시험 작품',
    visibility: 'private',
    status: null,
    updatedAt: null,
    fields: { title: '시험 작품', main: '메인', description: '소개' },
    lorebook: [],
    startScenarios: [
      {
        id: 1,
        title: '기본',
        isDefault: true,
        content: '처음',
        subPrompt: '',
        dialogue: '',
        situation: '',
        description: ''
      }
    ],
    characters: [
      { id: 'c1', name: '주연', isMain: true, order: 0, details: '설정', info: '', imageCount: 0 }
    ],
    ...over
  }
}

const state: { raw: Raw; removed: boolean; saves: number } = {
  raw: { body: body(), groups: [] },
  removed: false,
  saves: 0
}

function applyChanges(raw: unknown, c: WorkChanges): unknown {
  const next = structuredClone(raw) as Raw
  const b = next.body
  if (c.fields) Object.assign(b.fields, c.fields)
  for (const p of c.startScenarios ?? []) {
    if (!b.startScenarios[p.index]) throw new Error('BAD_INDEX')
    const { index, ...rest } = p
    void index
    Object.assign(b.startScenarios[p.index], rest)
  }
  for (const s of c.startScenariosAdd ?? [])
    b.startScenarios.push({
      id: null,
      title: s.title ?? '',
      isDefault: false,
      content: s.content ?? '',
      subPrompt: s.subPrompt ?? '',
      dialogue: s.dialogue ?? '',
      situation: s.situation ?? '',
      description: s.description ?? ''
    })
  for (const p of c.characters ?? []) {
    if (!b.characters[p.index]) throw new Error('BAD_INDEX')
    const { index, ...rest } = p
    void index
    Object.assign(b.characters[p.index], rest)
  }
  return next
}

const fake: WorkAdapter = {
  id: 'fake',
  label: '시험',
  capabilities: ['works_list', 'work_read', 'save', 'images'],
  guide: { save: '시험 플랫폼은 저장하면 버전이 오른다.', manual: ['손으로 할 일'] },
  readAllowed: () => true,
  async list() {
    return state.removed
      ? []
      : [
          {
            id: ID,
            title: state.raw.body.title,
            visibility: null,
            status: null,
            updatedAt: null,
            characters: 1
          }
        ]
  },
  async readRaw(_read, id) {
    if (id !== ID || state.removed) throw new Error('WORK_NOT_FOUND')
    return structuredClone(state.raw)
  },
  normalize: (raw) => (raw as Raw).body,
  writeAllowed: () => true,
  applyChanges,
  async save(_write, _id, next) {
    state.saves++
    state.raw = structuredClone(next) as Raw
  },
  async remove() {
    state.removed = true
  },
  // 언어 판본: 원문과 같은 모양 하나만 둔다
  async editions() {
    return [
      { language: 'ko', isSource: true, exists: true, status: null, stale: false },
      { language: 'en', isSource: false, exists: true, status: null, stale: false }
    ]
  },
  async readEditionRaw() {
    return structuredClone(state.raw)
  },
  normalizeEdition: (raw) => ({ ...(raw as Raw).body, language: 'en', exists: true, stale: false }),
  editionView: (source) => source,
  applyEditionChanges: applyChanges,
  async saveEdition(_write, _id, _language, view) {
    state.raw = structuredClone(view) as Raw
  },
  imageRules: { extensions: ['webp'], maxBytes: 1_000_000 },
  imageGroups: (raw) => (raw as Raw).groups,
  planImages: (_raw, changes) => [
    ...(changes.add ?? []).map(() => ({ action: 'add' as const, detail: '더하기' })),
    ...(changes.remove ?? []).map((i) => ({ action: 'remove' as const, detail: '#' + i }))
  ],
  async applyImages(_io, _id, raw, changes) {
    const next = structuredClone(raw) as Raw
    const g = next.groups[changes.character ?? 0]
    g.images = g.images.filter((_, i) => !(changes.remove ?? []).includes(i))
    for (const [n, a] of (changes.add ?? []).entries())
      g.images.push({ ...img(90_000 + n), label: a.label ?? '' })
    state.raw = next
  }
}

const WEBP = new Uint8Array(64)
WEBP.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

function tools(files: Record<string, string> = {}): (name: string, args?: Obj) => Promise<Obj> {
  const unused = (): never => {
    throw new Error('UNUSED')
  }
  const all = createWorkTools({
    reader: () => unused,
    writer: () => unused,
    sender: () => unused,
    snapshot: async () => 'C:/snap.json',
    readFile: async (path) => {
      if (!(path in files)) throw new Error('ENOENT')
      return files[path]
    },
    readBinary: async (path) => {
      if (path !== 'D:/new.webp') throw new Error('ENOENT')
      return WEBP
    },
    listFolder: async () => []
  })
  return (name, args = {}) => all.find((t) => t.name === name)!.run(args) as Promise<Obj>
}

beforeEach(() => {
  WORK_ADAPTERS.fake = fake
  state.raw = { body: body(), groups: [] }
  state.removed = false
  state.saves = 0
})
afterEach(() => {
  delete WORK_ADAPTERS.fake
})

describe('sites_list 플랫폼 안내', () => {
  it('11개 연결부 모두 save·manual·unverified를 돌려준다', async () => {
    delete WORK_ADAPTERS.fake
    const out = await tools()('sites_list')
    const sites = out.sites as Obj[]
    expect(sites).toHaveLength(11)
    for (const s of sites) {
      const guide = s.guide as { save: string; manual: string[]; unverified: string[] }
      expect(guide, s.site as string).not.toBeNull()
      expect(guide.save.length).toBeGreaterThan(5)
      expect(Array.isArray(guide.manual)).toBe(true)
      expect(Array.isArray(guide.unverified)).toBe(true)
    }
    const by = (id: string): Obj => sites.find((s) => s.site === id)!.guide as Obj
    expect(String(by('crack').save)).toContain('버전이 오른다')
    expect(String(by('teapot').save)).toContain('서비스 중인 작품은 바뀌지 않는다')
    expect(String(by('uumai').save)).toContain('초안')
    expect(String(by('luna').save)).toContain('읽기만')
    expect((by('chatple').unverified as string[])[0]).toContain('쓰기 전부')
    expect(by('teapot').manual).toEqual(['등록(심사 제출)', '공개 상태 바꾸기', '이미지 올리기'])
    expect(out.manual_everywhere).toEqual(['실제 채팅 시험(로어북 발동, 이미지 출력 확인)'])
  })

  it('계획 단계 결과에 platform_note가 붙는다', async () => {
    const run = tools()
    const plan = await run('work_plan', { site: 'fake', work_id: ID, fields: { main: '새 메인' } })
    expect(plan.platform_note).toBe('시험 플랫폼은 저장하면 버전이 오른다.')
    expect(plan.note).toContain('공개 상태는 바뀌지 않아요')
    const del = await run('work_delete_plan', { site: 'fake', work_id: ID })
    expect(del.platform_note).toBe('시험 플랫폼은 저장하면 버전이 오른다.')
    const ed = await run('edition_plan', {
      site: 'fake',
      work_id: ID,
      language: 'en',
      fields: { main: 'main' }
    })
    expect(ed.platform_note).toBe('시험 플랫폼은 저장하면 버전이 오른다.')
  })
})

describe('work_read 나눠 읽기', () => {
  const long = 'ㄱ'.repeat(45_000)
  beforeEach(() => {
    state.raw.body.fields.main = long
  })

  it('짧은 칸은 예전 모양 그대로', async () => {
    const out = await tools()('work_read', { site: 'fake', work_id: ID, fields: ['description'] })
    expect(out.content).toEqual({ description: '소개' })
    expect(out.content_parts).toBeUndefined()
  })

  it('긴 칸은 max_chars만큼 주고 offset으로 이어 읽는다', async () => {
    const run = tools()
    const first = await run('work_read', { site: 'fake', work_id: ID, fields: ['main'] })
    expect((first.content as Obj).main).toHaveLength(20_000)
    expect(first.content_parts).toEqual({ main: { total: 45_000, offset: 0, next_offset: 20_000 } })

    const last = await run('work_read', {
      site: 'fake',
      work_id: ID,
      fields: ['main'],
      offset: 40_000
    })
    expect((last.content as Obj).main).toHaveLength(5_000)
    expect(last.content_parts).toEqual({
      main: { total: 45_000, offset: 40_000, next_offset: null }
    })

    const big = await run('work_read', {
      site: 'fake',
      work_id: ID,
      fields: ['main'],
      max_chars: 500_000
    })
    expect((big.content as Obj).main).toHaveLength(45_000)
    expect(big.content_parts).toBeUndefined()

    const small = await run('work_read', {
      site: 'fake',
      work_id: ID,
      fields: ['main'],
      max_chars: 10
    })
    expect((small.content as Obj).main).toHaveLength(1_000)
  })

  it('여러 칸이면 각각 처음부터, offset은 칸 하나일 때만', async () => {
    const run = tools()
    const out = await run('work_read', {
      site: 'fake',
      work_id: ID,
      fields: ['main', 'description']
    })
    expect((out.content as Obj).main).toHaveLength(20_000)
    expect((out.content as Obj).description).toBe('소개')
    await expect(
      run('work_read', { site: 'fake', work_id: ID, fields: ['main', 'description'], offset: 5 })
    ).rejects.toThrow('BAD_RANGE')
    await expect(
      run('work_read', { site: 'fake', work_id: ID, fields: ['main'], offset: 45_000 })
    ).rejects.toThrow('BAD_RANGE')
    await expect(run('work_read', { site: 'fake', work_id: ID, offset: 0 })).rejects.toThrow(
      'BAD_RANGE'
    )
    expect(toolMessage(new Error('BAD_RANGE offset'))).toContain('칸을 하나만')
  })

  it('두 칸짜리 글자를 반으로 자르지 않는다', async () => {
    state.raw.body.fields.main = 'a'.repeat(999) + '🌸' + 'b'.repeat(10)
    const run = tools()
    const out = await run('work_read', {
      site: 'fake',
      work_id: ID,
      fields: ['main'],
      max_chars: 1000
    })
    expect((out.content as Obj).main).toBe('a'.repeat(999))
    const next = (out.content_parts as Record<string, { next_offset: number }>).main.next_offset
    const rest = await run('work_read', {
      site: 'fake',
      work_id: ID,
      fields: ['main'],
      offset: next
    })
    expect(String((rest.content as Obj).main).startsWith('🌸')).toBe(true)
  })

  it('edition_read는 칸들의 본문 합이 넘으면 뒤 칸을 길이만 준다', async () => {
    state.raw.body.fields.main = 'm'.repeat(15_000)
    state.raw.body.fields.description = 'd'.repeat(10_000)
    const out = await tools()('edition_read', {
      site: 'fake',
      work_id: ID,
      language: 'en',
      fields: ['main', 'description', 'title']
    })
    expect(Object.keys(out.content as Obj)).toEqual(['main'])
    expect(out.truncated).toBe(true)
    expect(out.omitted_fields).toEqual([
      { field: 'description', length: 10_000 },
      { field: 'title', length: 5 }
    ])
  })
})

describe('목록 읽기의 본문 합 한도', () => {
  it('lorebook_read: 넘친 뒤 항목은 본문 없이 길이만', async () => {
    state.raw.body.lorebook = Array.from({ length: 5 }, (_, i) => ({
      title: '항목' + i,
      keys: 'k' + i,
      content: String(i).repeat(6_000),
      mode: null,
      offKeys: [],
      turnRange: null,
      offTurnRange: null
    }))
    const run = tools()
    const out = await run('lorebook_read', { site: 'fake', work_id: ID })
    const entries = out.entries as Obj[]
    expect(entries.slice(0, 3).every((e) => typeof e.content === 'string')).toBe(true)
    expect(entries[3]).toEqual({
      index: 3,
      title: '항목3',
      keys: 'k3',
      mode: null,
      length: 6_000,
      omitted: true
    })
    expect(out).toMatchObject({ truncated: true, omitted_indexes: [3, 4] })
    expect(String(out.note)).toContain('indexes')

    const rest = await run('lorebook_read', { site: 'fake', work_id: ID, indexes: [3, 4] })
    expect(rest.truncated).toBeUndefined()
    expect((rest.entries as Obj[]).map((e) => e.index)).toEqual([3, 4])
  })

  it('start_scenarios_read·characters_read도 같은 규칙이고, 작으면 예전 모양', async () => {
    const run = tools()
    const small = await run('start_scenarios_read', { site: 'fake', work_id: ID })
    expect(small).toEqual({ scenarios: [{ index: 0, ...state.raw.body.startScenarios[0] }] })
    state.raw.body.characters.push({
      id: 'c2',
      name: '조연',
      isMain: false,
      order: 1,
      details: 'z'.repeat(3_000),
      info: '',
      imageCount: 0
    })
    state.raw.body.characters[0].details = 'y'.repeat(2_000)
    const chars = await tools()('characters_read', { site: 'fake', work_id: ID, max_chars: 1_000 })
    expect((chars.characters as Obj[])[1]).toMatchObject({ index: 1, name: '조연', omitted: true })
    expect(chars.truncated).toBe(true)
  })
})

describe('이미지 목록 나눠 주기', () => {
  beforeEach(() => {
    state.raw.groups = [
      {
        character: 0,
        name: '에셋',
        images: Array.from({ length: 2_530 }, (_, i) => img(i))
      },
      { character: 1, name: '대표', images: [img(0, true), img(1)] }
    ]
  })

  it('기본은 묶음마다 50장과 count, index는 전체 기준', async () => {
    const run = tools()
    const out = await run('images_list', { site: 'fake', work_id: ID })
    expect(JSON.stringify(out).length).toBeLessThan(30_000)
    const [assets, cover] = out.groups as Obj[]
    expect(assets).toMatchObject({ count: 2_530, offset: 0, returned: 50, next_offset: 50 })
    expect(cover).toMatchObject({ count: 2, returned: 2, next_offset: null })
    expect(String(out.note)).toContain('next_offset')

    const tail = await run('images_list', {
      site: 'fake',
      work_id: ID,
      group: 0,
      offset: 2_500,
      limit: 500
    })
    const only = tail.groups as Obj[]
    expect(only).toHaveLength(1)
    expect(only[0]).toMatchObject({ group: 0, returned: 30, next_offset: null })
    expect(((only[0].images as Obj[])[0] as Obj).index).toBe(2_500)

    await expect(run('images_list', { site: 'fake', work_id: ID, group: 2 })).rejects.toThrow(
      'BAD_RANGE'
    )
    await expect(run('images_list', { site: 'fake', work_id: ID, limit: 501 })).rejects.toThrow(
      'BAD_RANGE'
    )
  })

  it('작은 작품은 예전처럼 전부, next_offset은 null', async () => {
    state.raw.groups = [{ character: null, name: '이미지', images: [img(0, true), img(1)] }]
    const out = await tools()('images_list', { site: 'fake', work_id: ID })
    expect(out.note).toBeUndefined()
    expect((out.groups as Obj[])[0]).toMatchObject({ count: 2, returned: 2, next_offset: null })
  })

  it('images_plan·images_apply 결과는 건드리는 곳 주변만, 검증은 전체로', async () => {
    const run = tools()
    const plan = await run('images_plan', {
      site: 'fake',
      work_id: ID,
      remove: [1_200],
      add: [{ file: 'D:/new.webp', label: 'new/one' }]
    })
    expect(JSON.stringify(plan).length).toBeLessThan(30_000)
    expect(plan.platform_note).toBe('시험 플랫폼은 저장하면 버전이 오른다.')
    const [assets, cover] = plan.current as Obj[]
    expect(assets).toMatchObject({ count: 2_530, partial: true })
    const shown = (assets.images as Obj[]).map((i) => i.index)
    expect(shown).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1_199, 1_200, 1_201, 2_528, 2_529])
    expect(cover).toMatchObject({ count: 2 })
    expect(cover.partial).toBeUndefined()

    const done = await run('images_apply', { plan_id: plan.plan_id })
    expect(done).toMatchObject({ applied: true, verified: true, mismatches: [] })
    expect(JSON.stringify(done).length).toBeLessThan(30_000)
    const after = (done.groups as Obj[])[0]
    expect(after).toMatchObject({ count: 2_530, partial: true })
    expect((after.images as Obj[]).at(-1)).toMatchObject({ index: 2_529, label: 'new/one' })
  })
})

describe('시작 상황·캐릭터 파일 입력', () => {
  it('work_plan의 start_scenarios_file · start_scenarios_add_file · characters_file', async () => {
    const run = tools({
      'D:/starts.json': JSON.stringify([{ index: 0, content: '긴 시작 상황' }]),
      'D:/adds.json': JSON.stringify([{ title: '둘째', content: '새 시작' }]),
      'D:/chars.json': '\ufeff' + JSON.stringify([{ index: 0, details: '파일 설정' }])
    })
    const plan = await run('work_plan', {
      site: 'fake',
      work_id: ID,
      start_scenarios_file: 'D:/starts.json',
      start_scenarios_add_file: 'D:/adds.json',
      characters_file: 'D:/chars.json'
    })
    const where = (plan.changes as Obj[]).map((c) => c.where)
    expect(where).toContain('start_scenarios[0] 기본 · content')
    expect(where).toContain('start_scenarios[1] 둘째')
    expect(where).toContain('characters[0] 주연 · details')
    await run('work_save', { plan_id: plan.plan_id })
    expect(state.raw.body.startScenarios.map((s) => s.content)).toEqual(['긴 시작 상황', '새 시작'])
    expect(state.raw.body.characters[0].details).toBe('파일 설정')
  })

  it('인라인과 파일을 같이 주면 BAD_CHANGES, index가 없으면 BAD_INDEX, 못 읽으면 BAD_FILE', async () => {
    const run = tools({
      'D:/starts.json': JSON.stringify([{ index: 0, content: 'x' }]),
      'D:/noindex.json': JSON.stringify([{ content: 'x' }]),
      'D:/bad.json': '{ 깨진'
    })
    await expect(
      run('work_plan', {
        site: 'fake',
        work_id: ID,
        start_scenarios: [{ index: 0, content: 'y' }],
        start_scenarios_file: 'D:/starts.json'
      })
    ).rejects.toThrow('BAD_CHANGES')
    await expect(
      run('work_plan', { site: 'fake', work_id: ID, characters_file: 'D:/noindex.json' })
    ).rejects.toThrow('BAD_INDEX')
    await expect(
      run('work_plan', { site: 'fake', work_id: ID, start_scenarios_file: 'D:/bad.json' })
    ).rejects.toThrow('BAD_FILE')
    await expect(
      run('work_plan', { site: 'fake', work_id: ID, start_scenarios_file: 'D:/starts.txt' })
    ).rejects.toThrow('BAD_FILE')
  })

  it('edition_plan도 start_scenarios_file · characters_file을 받는다', async () => {
    const run = tools({
      'D:/en-starts.json': JSON.stringify([{ index: 0, content: 'English start' }]),
      'D:/en-chars.json': JSON.stringify([{ index: 0, name: 'Lead' }])
    })
    const plan = await run('edition_plan', {
      site: 'fake',
      work_id: ID,
      language: 'en',
      start_scenarios_file: 'D:/en-starts.json',
      characters_file: 'D:/en-chars.json'
    })
    const where = (plan.changes as Obj[]).map((c) => c.where)
    expect(where).toContain('start_scenarios[0] 기본 · content')
    expect(where).toContain('characters[0] Lead · name')
  })
})

describe('제목이 빈 작품 삭제', () => {
  it('제목이 비면 작품 번호를 글자 그대로 넣어야 지운다', async () => {
    state.raw.body = body({ title: '', fields: { title: '', main: '메인' } })
    const run = tools()
    const del = await run('work_delete_plan', { site: 'fake', work_id: ID })
    expect(del.confirm_title).toBe(ID)
    expect(String(del.note)).toContain(ID)
    await expect(run('work_delete', { plan_id: del.plan_id, title: '' })).rejects.toThrow(
      'TITLE_MISMATCH'
    )
    const done = await run('work_delete', { plan_id: del.plan_id, title: ID })
    expect(done).toMatchObject({ deleted: true, verified: true })
  })

  it('제목이 있으면 예전처럼 제목으로 지운다', async () => {
    const run = tools()
    const del = await run('work_delete_plan', { site: 'fake', work_id: ID })
    expect(del.confirm_title).toBe('시험 작품')
    await expect(run('work_delete', { plan_id: del.plan_id, title: ID })).rejects.toThrow(
      'TITLE_MISMATCH'
    )
    expect((await run('work_delete', { plan_id: del.plan_id, title: '시험 작품' })).deleted).toBe(
      true
    )
  })
})
