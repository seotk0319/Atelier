import { describe, expect, it } from 'vitest'
import { edenWorks } from '../src/main/works/eden'
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
