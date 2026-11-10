import { describe, expect, it } from 'vitest'
import { edenWorks } from '../src/main/works/eden'
import { edenEditionBody, edenEditionView } from '../src/main/works/eden-editions'
import { babeCreateBody, babeWorks } from '../src/main/works/babe'
import { workSendRule, workWriteAllowed } from '../src/main/works/adapters'
import { createWorkTools, toolMessage } from '../src/main/works/tools'
import type { WorkFetch, WorkSend, WorkWrite } from '../src/main/works/types'

type Obj = Record<string, unknown>
const O = 'https://www.eden-chat.com'
const W = '11111111-2222-4333-8444-555555555555'
const C1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const C2 = 'aaaaaaaa-0000-4000-8000-000000000002'

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const lore = (title: string, key: string, value: string): Obj => ({
  title,
  key,
  value,
  triggerMode: 'keyword',
  offKeywords: [],
  turnRange: 5,
  offTurnRange: 5
})

function source(): Obj {
  return {
    work: {
      id: W,
      title: '작품',
      subtitle: '부제',
      description: '소개',
      creator_comment: null,
      scenario_settings: '메인',
      tags: [],
      hashtags: ['순애'],
      cover_image_url: 'https://cdn.example/ko.webp',
      visibility: 'public',
      status: 'active',
      lorebook: [lore('학교', '학교', '학교 설명')],
      start_scenarios: [
        {
          id: 1,
          title: '기본',
          isDefault: true,
          detailedSettings: '시작',
          situation: '',
          dialogue: '안녕'
        },
        { id: 2, title: '둘째', isDefault: false, detailedSettings: '둘째 시작', dialogue: '' }
      ],
      recommended_personas: [{ id: 'p1', name: '철수', description: '학생' }]
    },
    characters: [
      { id: C1, character_name: '주연', character_details: '주연 설정', is_main_character: true },
      { id: C2, character_name: '조연', character_details: '조연 설정', is_main_character: false }
    ],
    images: { [C1]: [], [C2]: [] }
  }
}
function english(): Obj {
  return {
    language_code: 'en',
    exists: true,
    status: 'active',
    stale: true,
    work: {
      title: 'Work',
      subtitle: '',
      scenario_settings: 'Main',
      hashtags: [],
      lorebook: [lore('School', 'school', 'About the school')],
      start_scenarios: [
        { id: 1, title: 'Default', detailedSettings: 'Start', situation: 'Ignored', dialogue: 'Hi' }
      ],
      recommended_personas: [{ id: 'p1', name: 'Chulsoo' }]
    },
    characters: [{ character_id: C1, character_name: 'Lead', character_details: '' }]
  }
}

describe('판본 겹치기와 저장 본문', () => {
  it('판본에 값이 있는 칸만 판본 글, 나머지는 원문 글 (구조는 원문)', () => {
    const view = edenEditionView(source(), english())
    const w = view.work as Obj
    expect(w.title).toBe('Work')
    expect(w.scenario_settings).toBe('Main')
    // 빈 글·빈 배열은 값이 없는 것으로 본다
    expect(w.subtitle).toBe('부제')
    expect(w.description).toBe('소개')
    expect(w.hashtags).toEqual(['순애'])
    expect(w.cover_image_url).toBe('https://cdn.example/ko.webp')
    expect(w.lorebook).toEqual([lore('School', 'school', 'About the school')])
    // 시작 상황: 번호가 같고 원문·판본 둘 다 글이 있는 칸만 바뀐다. 판본에 없는 것은 원문 그대로 남는다.
    expect(w.start_scenarios).toEqual([
      {
        id: 1,
        title: 'Default',
        isDefault: true,
        detailedSettings: 'Start',
        situation: '',
        dialogue: 'Hi'
      },
      { id: 2, title: '둘째', isDefault: false, detailedSettings: '둘째 시작', dialogue: '' }
    ])
    expect(w.recommended_personas).toEqual([
      { id: 'p1', name: 'Chulsoo', description: '학생', source_name: '철수' }
    ])
    expect((view.characters as Obj[]).map((c) => [c.character_name, c.character_details])).toEqual([
      ['Lead', '주연 설정'],
      ['조연', '조연 설정']
    ])
    // 공개 상태는 원문 값이고 저장 본문에는 들어가지 않는다
    expect(w.visibility).toBe('public')
    // 판본이 없으면 원문 그대로
    const none = edenEditionView(source(), {
      language_code: 'ja',
      exists: false,
      work: { title: 'x' }
    })
    expect((none.work as Obj).title).toBe('작품')
    expect(none.edition).toEqual({ language: 'ja', exists: false })
    expect(() => edenEditionView({}, english())).toThrow('EDITION_SHAPE')
  })

  it('저장 본문은 편집기의 번역 저장과 같은 칸만 담는다', () => {
    const body = edenEditionBody(edenEditionView(source(), english()))
    expect(Object.keys(body)).toEqual(['work', 'characters'])
    expect(Object.keys(body.work as Obj).sort()).toEqual([
      'cover_image_url',
      'creator_comment',
      'description',
      'hashtags',
      'lorebook',
      'recommended_personas',
      'scenario_settings',
      'start_scenarios',
      'subtitle',
      'tags',
      'title'
    ])
    expect(body.work).toMatchObject({ title: 'Work', creator_comment: '', hashtags: ['순애'] })
    expect(body.characters).toEqual([
      {
        character_id: C1,
        character_name: 'Lead',
        character_info: undefined,
        character_details: '주연 설정',
        scenario_settings: undefined,
        lorebook: null
      },
      {
        character_id: C2,
        character_name: '조연',
        character_info: undefined,
        character_details: '조연 설정',
        scenario_settings: undefined,
        lorebook: null
      }
    ])
    // 공개 상태·작품 종류 같은 원문 전용 칸은 보내지 않는다
    const json = JSON.stringify(body)
    for (const key of ['visibility', 'status', 'is_nsfw', 'delete_missing', 'images'])
      expect(json).not.toContain('"' + key + '"')
    // 표지 주소가 http 주소가 아니면 칸을 뺀다
    const view = edenEditionView(source(), english())
    ;(view.work as Obj).cover_image_url = 'blob:local'
    expect('cover_image_url' in (edenEditionBody(view).work as Obj)).toBe(false)
    ;(view.work as Obj).title = ' '
    expect(() => edenEditionBody(view)).toThrow('EMPTY_FIELD')
  })
})

/** 에덴 흉내: 원문은 읽기만, 판본은 PUT으로 통째 바뀐다 */
function eden(): {
  read: WorkFetch
  write: WorkWrite
  send: WorkSend
  calls: string[]
  src: Obj
  editions: Record<string, Obj>
} {
  const s = {
    calls: [] as string[],
    src: source(),
    editions: {
      en: english(),
      ja: { language_code: 'ja', exists: false, work: {}, characters: [] }
    } as Record<string, Obj>
  }
  const read: WorkFetch = async (url) => {
    if (!edenWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE')
    const path = new URL(url).pathname.replace('/api/works/' + W, '')
    if (path === '') return ok(s.src.work)
    if (path === '/characters') return ok(s.src.characters)
    if (path === '/translations')
      return ok({
        items: [
          { language_code: 'ko', is_source: true, exists: true },
          { language_code: 'en', is_source: false, exists: s.editions.en.exists },
          { language_code: 'ja', is_source: false, exists: s.editions.ja.exists }
        ]
      })
    const lang = /^\/translations\/([A-Za-z-]+)$/.exec(path)
    if (lang) return s.editions[lang[1]] ? ok({ item: s.editions[lang[1]] }) : ok({}, 400)
    return ok([])
  }
  const write: WorkWrite = async (method, url, body) => {
    if (!edenWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE')
    const path = new URL(url).pathname.replace('/api/works/' + W, '')
    s.calls.push(method + ' ' + path)
    const lang = /^\/translations\/([A-Za-z-]+)$/.exec(path)![1]
    const item = {
      language_code: lang,
      exists: true,
      status: 'draft',
      stale: false,
      translation_source: 'manual',
      // JSON으로 오가며 undefined 칸은 사라진다
      ...(JSON.parse(JSON.stringify(body)) as Obj)
    }
    s.editions[lang] = item
    return ok({ item })
  }
  const send: WorkSend = async (request) => {
    workSendRule('eden', request)
    throw new Error('not used')
  }
  return Object.assign(s, { read, write, send })
}

function tools(s: ReturnType<typeof eden>): (name: string, args?: Obj) => Promise<Obj> {
  const all = createWorkTools({
    reader: () => s.read,
    writer: () => s.write,
    sender: () => s.send,
    snapshot: async (_platform, name) => 'C:/snap/' + name + '.json',
    readFile: async (path) => {
      if (path !== 'D:/tr/main.en.md') throw new Error('ENOENT')
      return '\uFEFFNew main\r\nline two'
    },
    readBinary: async () => {
      throw new Error('ENOENT')
    },
    listFolder: async () => []
  })
  return (name, args = {}) => all.find((t) => t.name === name)!.run(args) as Promise<Obj>
}

describe('판본 저장 도구', () => {
  it('계획(아무것도 안 씀) → 저장 → 다시 읽어 확인. 원문은 건드리지 않는다', async () => {
    const s = eden()
    const run = tools(s)
    const before = JSON.stringify(s.src)
    const plan = await run('edition_plan', {
      site: 'eden',
      work_id: W,
      language: 'EN',
      fields: { title: 'New Title' },
      field_files: { main: 'D:/tr/main.en.md' },
      lorebook_patch: [{ index: 0, content: 'Updated school' }],
      start_scenarios: [{ index: 0, content: 'New start' }],
      characters: [{ index: 1, name: 'Support' }]
    })
    expect(plan).toMatchObject({ language: 'en', exists: true })
    expect((plan.changes as Obj[]).map((c) => c.where)).toEqual([
      'title',
      'main',
      'lorebook[0] School · content',
      'start_scenarios[0] Default · content',
      'characters[1] Support · name'
    ])
    expect(s.calls).toEqual([])

    const saved = await run('edition_save', { plan_id: plan.plan_id })
    expect(saved).toMatchObject({
      saved: true,
      verified: true,
      mismatches: [],
      language: 'en',
      backup: 'C:/snap/' + W + '__en.json'
    })
    expect(s.calls).toEqual(['PUT /translations/en'])
    const en = s.editions.en
    expect(en.work).toMatchObject({
      title: 'New Title',
      scenario_settings: 'New main\nline two',
      // 바꾸지 않은 칸: 판본에 없던 것은 원문 글이 들어간다
      subtitle: '부제',
      description: '소개'
    })
    expect(((en.work as Obj).lorebook as Obj[])[0]).toMatchObject({
      title: 'School',
      value: 'Updated school'
    })
    expect(((en.work as Obj).start_scenarios as Obj[]).map((x) => x.detailedSettings)).toEqual([
      'New start',
      '둘째 시작'
    ])
    expect((en.characters as Obj[]).map((c) => [c.character_id, c.character_name])).toEqual([
      [C1, 'Lead'],
      [C2, 'Support']
    ])
    expect(JSON.stringify(s.src)).toBe(before)
    await expect(run('edition_save', { plan_id: plan.plan_id })).rejects.toThrow('PLAN_NOT_FOUND')
  })

  it('아직 없는 판본은 저장하면 새로 생긴다고 미리 알린다', async () => {
    const s = eden()
    const run = tools(s)
    const plan = await run('edition_plan', {
      site: 'eden',
      work_id: W,
      language: 'ja',
      fields: { title: '作品', main: 'メイン' }
    })
    expect(plan.exists).toBe(false)
    expect(String(plan.note)).toContain('새로 생기고')
    expect(await run('edition_save', { plan_id: plan.plan_id })).toMatchObject({ verified: true })
    expect(s.editions.ja).toMatchObject({
      exists: true,
      work: { title: '作品', description: '소개' }
    })
  })

  it('판본에서 못 하는 것과 잘못된 언어는 플랫폼에 닿기 전에 막는다', async () => {
    const s = eden()
    const run = tools(s)
    const plan = (args: Obj): Promise<Obj> =>
      run('edition_plan', { site: 'eden', work_id: W, language: 'en', ...args })
    // 원문 언어, 목록에 없는 언어
    await expect(plan({ language: 'ko', fields: { title: 'x' } })).rejects.toThrow('BAD_LANGUAGE')
    await expect(plan({ language: 'fr', fields: { title: 'x' } })).rejects.toThrow('BAD_LANGUAGE')
    await expect(plan({})).rejects.toThrow('NO_CHANGES')
    // 구조·공개 상태 바꾸기는 입력으로 받지 않는다 (주면 바꿀 내용이 없는 것으로 본다)
    await expect(plan({ visibility: 'public' })).rejects.toThrow('NO_CHANGES')
    await expect(plan({ characters_remove: [1] })).rejects.toThrow('NO_CHANGES')
    await expect(plan({ fields: { title: ' ' } })).rejects.toThrow('EMPTY_FIELD')
    await expect(plan({ fields: { nope: 'x' } })).rejects.toThrow('BAD_FIELD')
    // 연결부를 직접 불러도 구조 바꾸기는 거절한다
    const view = edenWorks.editionView!(s.src, s.editions.en)
    for (const changes of [
      { visibility: 'private' },
      { charactersRemove: [1] },
      { charactersAdd: [{ name: 'x' }] },
      { startScenariosRemove: [1] },
      { startScenariosAdd: [{}] }
    ])
      expect(() => edenWorks.applyEditionChanges!(view, changes)).toThrow('EDITION_FIXED')
    await expect(
      run('edition_plan', { site: 'babe', work_id: W, language: 'en', fields: { title: 'x' } })
    ).rejects.toThrow('NO_EDITION_SAVE')
    // 같은 값이면 저장할 것이 없다
    expect(await plan({ fields: { title: 'Work' } })).toMatchObject({ nothing_to_save: true })
    expect(s.calls).toEqual([])
    expect(toolMessage(new Error('EDITION_FIXED'))).toContain('글만')
  })

  it('계획 뒤 원문이나 판본이 바뀌었으면 저장하지 않는다', async () => {
    const s = eden()
    const run = tools(s)
    const one = await run('edition_plan', {
      site: 'eden',
      work_id: W,
      language: 'en',
      fields: { title: 'A' }
    })
    ;(s.editions.en.work as Obj).scenario_settings = 'Changed elsewhere'
    await expect(run('edition_save', { plan_id: one.plan_id })).rejects.toThrow('PLAN_STALE')
    const two = await run('edition_plan', {
      site: 'eden',
      work_id: W,
      language: 'en',
      fields: { title: 'A' }
    })
    ;(s.src.work as Obj).description = '원문 소개가 바뀜'
    await expect(run('edition_save', { plan_id: two.plan_id })).rejects.toThrow('PLAN_STALE')
    expect(s.calls).toEqual([])
  })

  it('자동 번역 주소로는 어떤 방법으로도 나가지 않는다', () => {
    const base = O + '/api/works/' + W
    expect(workWriteAllowed('eden', 'PUT', base + '/translations/en')).toBe(true)
    for (const [method, path] of [
      ['POST', '/translations/en'],
      ['POST', '/translation-drafts'],
      ['PATCH', '/translation-drafts/abc'],
      ['POST', '/jsx-translations'],
      ['PUT', '/translations/en/extra'],
      ['PUT', '/translations/../' + W]
    ])
      expect(workWriteAllowed('eden', method, base + path)).toBe(false)
    expect(edenWorks.sendRule!('POST', base + '/translations/en')).toBeNull()
    expect(edenWorks.sendRule!('POST', base + '/translation-drafts')).toBeNull()
  })
})

// ───────────── 베이비챗 새 작품 ─────────────

const B = 'https://api.babechatapi.com/ko/api/characters/'
const NEW = '33333333-2222-4333-8444-555555555555'
const COVER = 'https://py27ckpypvqi2sq0.public.blob.vercel-storage.com/c.webp'
const draft = (over: Obj = {}): Parameters<typeof babeCreateBody>[0] =>
  ({
    title: '새 작품',
    main: '캐릭터 설정',
    adult: true,
    description: '소개',
    hashtags: ['순애', '학원'],
    characters: [],
    startScenarios: [{ title: '기본', content: '첫 상황', dialogue: '첫 대사' }],
    coverUrl: COVER,
    options: { category: 3, target_gender: 'male', recommended_model: 'model-a' },
    ...over
  }) as Parameters<typeof babeCreateBody>[0]

describe('베이비챗 새 작품', () => {
  it('본문: 항상 비공개, 저장 본문과 같은 모양, 버전 정보 없음', () => {
    const body = babeCreateBody(
      draft({
        lorebook: [
          {
            title: '학교',
            keys: '학교, 교실',
            content: '설명',
            mode: null,
            offKeys: [],
            turnRange: null,
            offTurnRange: null
          }
        ],
        startScenarios: [
          { title: '기본', content: '첫 상황', dialogue: '첫 대사', description: '안내' },
          { title: '둘째', content: '둘째 상황', dialogue: '둘째 대사' }
        ]
      })
    )
    expect(body).toMatchObject({
      name: '새 작품',
      description: '소개',
      image: COVER,
      emotionImages: [],
      characterDetails: '캐릭터 설정',
      initialTitle: '기본',
      initialAction: '첫 상황',
      initialMessage: '첫 대사',
      playGuide: '안내',
      isAdult: true,
      category: 3,
      tags: ['순애', '학원'],
      targetGender: 'male',
      visibility: 'private',
      babechatOnly: false,
      creatorKeywordBookLimit: 5,
      recommendedModel: 'model-a',
      keywordBooks: [{ title: '학교', content: '설명', keywords: ['학교', '교실'], order: 0 }],
      startingScenarios: [
        {
          initialTitle: '둘째',
          initialAction: '둘째 상황',
          initialMessage: '둘째 대사',
          replySuggestions: []
        }
      ]
    })
    // 기본 프롬프트는 칸을 비워 보낸다 (편집기와 같다)
    expect(body.systemPrompt).toBeUndefined()
    for (const key of ['baseVersion', 'creatorComment', 'notifyFollowers'])
      expect(key in body).toBe(false)
    // 공개로 만들 방법은 없다
    expect(
      babeCreateBody(draft({ options: { ...draft().options, visibility: 'public' } })).visibility
    ).toBe('private')
  })

  it('편집기 입력 규칙에 어긋나면 플랫폼에 닿기 전에 막는다', () => {
    const bad =
      (over: Obj): (() => unknown) =>
      () =>
        babeCreateBody(draft(over))
    expect(bad({ coverUrl: undefined })).toThrow('COVER_REQUIRED')
    expect(bad({ coverUrl: 'http://x/a.webp' })).toThrow('COVER_REQUIRED')
    expect(bad({ characters: [{ name: '주연' }] })).toThrow('NO_CHARACTERS')
    expect(bad({ title: 'a'.repeat(21) })).toThrow('BAD_DRAFT title')
    expect(bad({ title: ' ' })).toThrow('BAD_DRAFT title')
    expect(bad({ description: undefined })).toThrow('BAD_DRAFT description')
    expect(bad({ main: 'a'.repeat(5001) })).toThrow('BAD_DRAFT main 1~5000자')
    expect(
      babeCreateBody(
        draft({
          main: 'a'.repeat(7000),
          options: { ...draft().options, system_prompt: 'custom_plus' }
        })
      ).systemPrompt
    ).toBe('custom_plus')
    expect(bad({ hashtags: [] })).toThrow('BAD_DRAFT hashtags')
    expect(bad({ hashtags: Array.from({ length: 11 }, (_, i) => 't' + i) })).toThrow(
      'BAD_DRAFT hashtags'
    )
    expect(bad({ options: { category: 3, target_gender: 'male' } })).toThrow('recommended_model')
    expect(
      bad({ options: { category: '3', target_gender: 'male', recommended_model: 'm' } })
    ).toThrow('options.category')
    expect(bad({ options: { category: 3, target_gender: 'x', recommended_model: 'm' } })).toThrow(
      'target_gender'
    )
    expect(bad({ startScenarios: [] })).toThrow('BAD_DRAFT start_scenarios')
    expect(bad({ startScenarios: [{ title: '기본', content: '상황' }] })).toThrow('dialogue')
    expect(
      bad({ startScenarios: [{ title: 'a'.repeat(16), content: 'c', dialogue: 'd' }] })
    ).toThrow('title 1~15자')
    const s = { title: 't', content: 'c', dialogue: 'd' }
    expect(bad({ startScenarios: [s, s, s, s] })).toThrow('START_LIMIT')
    expect(bad({ startScenarios: [{ ...s, subPrompt: 'x' }] })).toThrow('BAD_CHANGES')
    const entry = {
      title: '학교',
      keys: '학교',
      content: '설명',
      mode: null,
      offKeys: [],
      turnRange: null,
      offTurnRange: null
    }
    expect(bad({ lorebook: [{ ...entry, keys: '' }] })).toThrow('키워드 1~5개')
    expect(bad({ lorebook: [{ ...entry, keys: 'a,b,c,d,e,f' }] })).toThrow('키워드 1~5개')
    expect(bad({ lorebook: [{ ...entry, content: 'a'.repeat(501) }] })).toThrow('content 1~500자')
    expect(toolMessage(new Error('BAD_DRAFT title 1~20자'))).toContain('title 1~20자')
  })

  /** 베이비챗 흉내: 만들기를 받고, 목록·편집 데이터를 돌려준다 */
  function babe(reply: Obj): {
    read: WorkFetch
    write: WorkWrite
    send: WorkSend
    calls: string[]
    created: Obj[]
    uploads: string[]
  } {
    const s = { calls: [] as string[], created: [] as Obj[], uploads: [] as string[] }
    const read: WorkFetch = async (url) => {
      if (!babeWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE')
      if (url.endsWith('/my'))
        return ok([
          { characterId: W, name: '옛 작품', visibility: 'public' },
          ...s.created.map((c) => ({ characterId: NEW, name: c.name, visibility: c.visibility }))
        ])
      const made = s.created[0]
      if (!made || !url.includes(NEW)) return ok({}, 404)
      return ok({
        ...made,
        version: 1,
        hashtags: made.tags,
        images: [{ url: made.image, emotion: null }],
        startingScenarios: made.startingScenarios ?? []
      })
    }
    const write: WorkWrite = async (method, url, body) => {
      if (!babeWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE')
      s.calls.push(method + ' ' + new URL(url).pathname)
      s.created.push(body as Obj)
      return ok(reply)
    }
    const send: WorkSend = async (request) => {
      workSendRule('babe', request)
      s.uploads.push(request.method + ' ' + new URL(request.url).host)
      return request.method === 'POST'
        ? ok({ clientToken: 'vercel_blob_client_py27ckpypvqi2sq0_abc' })
        : ok({ url: COVER })
    }
    return Object.assign(s, { read, write, send })
  }
  const WEBP = new Uint8Array(32)
  WEBP.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  const run = (s: ReturnType<typeof babe>, args: Obj): Promise<Obj> =>
    createWorkTools({
      reader: () => s.read,
      writer: () => s.write,
      sender: () => s.send,
      snapshot: async () => 'C:/snap.json',
      readFile: async () => '',
      readBinary: async (path) => {
        if (path !== 'D:/img/cover.webp') throw new Error('ENOENT')
        return WEBP
      },
      listFolder: async () => []
    })
      .find((t) => t.name === 'work_create')!
      .run(args) as Promise<Obj>
  const ARGS = {
    site: 'babe',
    title: '새 작품',
    main: '캐릭터 설정',
    adult: false,
    description: '소개',
    hashtags: ['순애'],
    cover_file: 'D:/img/cover.webp',
    start_scenarios: [{ title: '기본', content: '첫 상황', dialogue: '첫 대사' }],
    options: { category: 3, target_gender: 'all', recommended_model: 'model-a' }
  }

  it('work_create: 대표 이미지를 먼저 올리고 비공개로 만든다', async () => {
    const s = babe({ characterId: NEW })
    const made = await run(s, ARGS)
    expect(made).toMatchObject({
      created: true,
      id: NEW,
      title: '새 작품',
      visibility: 'private',
      start_scenario_count: 1
    })
    expect(s.uploads).toEqual(['POST babechat.ai', 'PUT vercel.com'])
    expect(s.calls).toEqual(['POST /ko/api/characters/create'])
    expect(s.created[0]).toMatchObject({ image: COVER, visibility: 'private', targetGender: 'all' })
  })

  it('응답에 번호가 없으면 목록에서 새로 생긴 작품을 찾는다', async () => {
    const s = babe({ ok: true })
    expect((await run(s, ARGS)).id).toBe(NEW)
    // 읽기 통로 없이 번호를 못 찾으면 만들어졌을 수 있다고 알린다
    const t = babe({})
    await expect(babeWorks.create!(t.write, draft())).rejects.toThrow('CREATED_ID_UNKNOWN')
    expect(toolMessage(new Error('CREATED_ID_UNKNOWN'))).toContain('works_list')
  })

  it('대표 이미지가 없거나 규격이 틀리면 만들지 않는다', async () => {
    const s = babe({ characterId: NEW })
    const { cover_file: _cover, ...noCover } = ARGS
    void _cover
    await expect(run(s, noCover)).rejects.toThrow('COVER_REQUIRED')
    await expect(run(s, { ...ARGS, cover_file: 'D:/img/none.webp' })).rejects.toThrow('BAD_IMAGE')
    await expect(run(s, { ...ARGS, cover_file: 'D:/img/cover.txt' })).rejects.toThrow('BAD_IMAGE')
    await expect(run(s, { ...ARGS, options: 'x' })).rejects.toThrow('BAD_CHANGES')
    // 규격이 틀리면 대표 이미지도 올리지 않는다
    await expect(run(s, { ...ARGS, characters: [{ name: '주연' }] })).rejects.toThrow(
      'NO_CHARACTERS'
    )
    await expect(run(s, { ...ARGS, hashtags: [] })).rejects.toThrow('BAD_DRAFT hashtags')
    expect(s.uploads).toEqual([])
    expect(s.calls).toEqual([])
    expect(workWriteAllowed('babe', 'POST', B + 'create')).toBe(true)
    expect(workWriteAllowed('babe', 'PUT', B + 'create')).toBe(false)
    expect(workWriteAllowed('babe', 'POST', B + 'create/draft')).toBe(false)
  })
})
